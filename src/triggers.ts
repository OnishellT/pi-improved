import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAdr } from "./adr.ts";
import { canonical, givenPath } from "./guards.ts";
import { inScope, isPiState, readTask, updateTask, type Task } from "./task-state.ts";

const ADR_DIR = "docs/adr/";
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/;
const MIGRATION = /(^|\/)(migrations?\/|db\/migrate\/|alembic\/versions\/)|(^|\/)schema\.prisma$|\.sql$/;
const INSTALLERS = /^(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)|(?:python3?\s+-m\s+)?pip3?\s+install|uv\s+(?:pip\s+install|add)|poetry\s+add|go\s+get|cargo\s+add|gem\s+install|composer\s+require)\s+(.+)$/;

export const toRelative = (cwd: string, p: string) => path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join("/");
export const isMigration = (p: string) => MIGRATION.test(p);
export const isManifest = (p: string) => MANIFEST.test(p);
/** The file a write or edit touches, as the tool resolves it (guards.ts), and its path from the project root. `names` adds the path as given, since a symlink and its target can have different names and either can make it a manifest or migration. */
const target = (event: any, cwd: string) => {
  const given = givenPath(String(event.input?.path ?? ""), cwd);
  const abs = canonical(given);
  const file = toRelative(canonical(cwd), abs);
  return { abs, file, names: [...new Set([file, toRelative(cwd, given)])] };
};

/** Package names (or local paths) a shell command installs; bare installs and `-r`/`-e` installs yield none. */
export function addedPackagesFromCommand(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const args = INSTALLERS.exec(segment.trim())?.[1].split(/\s+/);
    if (!args || args.some((a) => /^(-r|-e|--requirement|--editable)$/.test(a))) continue;
    for (const a of args) {
      // A local path (`./lib`) is a dependency too; `.` is the project itself.
      const local = /^(\.{1,2}\/|\/|~|file:)/.test(a);
      if (!a || /^\.\/?$/.test(a) || a.startsWith("-") || !local && a.includes("=") && !/[<>~!]=/.test(a) && !a.includes("==")) continue;
      names.push(local ? a : a.replace(/^(@?[^@=<>~!\[]+).*$/, "$1"));
    }
  }
  return [...new Set(names)];
}

/** A TOML dotted key as its parts: split on dots outside quotes, each trimmed and unquoted. `"a" . b` is [a, b]; `"a.b"` stays one part. */
export function keyPath(key: string): string[] {
  const parts = [""];
  let quote = "";
  for (const c of key) {
    if (!quote && c === ".") parts.push("");
    else {
      if (quote ? c === quote : c === '"' || c === "'") quote = quote ? "" : c;
      parts[parts.length - 1] += c;
    }
  }
  return parts.map((p) => p.trim().replace(/^(["'])(.*)\1$/, "$2"));
}

const quoted = (line: string) => [...line.matchAll(/["']([A-Za-z0-9_.-]+)[^"']*["']/g)].map((m) => m[1].toLowerCase());

/** Dependency names in a TOML manifest; undefined when a key or header has an escape (`\u0069`), which this reader does not decode. */
function tomlNames(content: string, python: boolean): Set<string> | undefined {
  const names = new Set<string>();
  let section: string[] = [];
  let inArray = false;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) {
      if (header[1].includes("\\")) return undefined;
      section = keyPath(header[1]);
      inArray = false;
      // `[dependencies.serde]`: a table per dependency.
      if (section.length > 1 && /dependencies$/.test(section.at(-2)!)) names.add(section.at(-1)!);
      continue;
    }
    const table = section.at(-1) ?? "";
    const depSection = /(^|-)dependencies$/.test(table) || section.join(".") === "dependency-groups";
    // The key before the first `=` outside quotes, and the value after it.
    const eq = /^((?:"[^"]*"|'[^']*'|[^"'=])+)=/.exec(line);
    if (eq?.[1].includes("\\")) return undefined;
    const key = eq ? keyPath(eq[1]) : [];
    const value = eq ? line.slice(eq[0].length).trim() : line;
    if (inArray || (python && value.startsWith("[") && (depSection || key.join(".") === "dependencies"))) {
      quoted(inArray ? line : value).forEach((n) => names.add(n));
      inArray = !line.includes("]");
    } else if (depSection && key[0] && key[0] !== "python") names.add(key[0]);
  }
  return names;
}

/** Dependency names declared in a manifest, or undefined when it can't be parsed. */
export function dependencyNames(file: string, content: string): Set<string> | undefined {
  const base = path.posix.basename(file);
  if (base === "package.json") {
    try {
      const json = JSON.parse(content || "{}");
      return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(json[k] ?? {})));
    } catch {
      return undefined;
    }
  }
  // An include (`-r other.txt`) counts as an entry, so adding one is a dependency change; its path keeps its case.
  if (base.endsWith(".txt")) return new Set(content.split("\n").flatMap((l) => /^(?:-r|--requirement).*|^[A-Za-z0-9_.-]+/.exec(l.trim())?.[0] ?? []).map((n) => (n.startsWith("-") ? n : n.toLowerCase())));
  if (base === "go.mod") return new Set([...content.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v[\w.+-]+/gm)].map((m) => m[1]));
  if (base === "Cargo.toml") return tomlNames(content, false);
  if (base === "pyproject.toml") return tomlNames(content, true);
}

/** Applies edit-tool entries to the original text; undefined if any oldText is not unique. */
export function applyEdits(original: string, edits: { oldText: string; newText: string }[]) {
  let result = original;
  for (const { oldText, newText } of edits) {
    if (!oldText || original.split(oldText).length !== 2) return undefined;
    result = result.replace(oldText, () => newText);
  }
  return result;
}

const read = (p: string) => fs.readFile(p, "utf8").catch(() => "");
const BLOCK = (what: string) => ({ block: true, reason: `The user rejected ${what}. Do not retry it. Choose another approach within the plan, or ask the user.` });

async function approveDependency(task: Task, ctx: ExtensionContext, title: string, names: string[] | undefined, decision: string) {
  const label = names?.join(", ") || "dependencies";
  const pick = await ctx.ui.select(`${title}: ${label}`, ["Approve and record ADR", "Block"]);
  if (pick !== "Approve and record ADR") return BLOCK("this dependency change");
  if (!names?.length) return; // the edit could not be parsed: approval only, no ADR naming nothing
  await writeAdr(ctx.cwd, { title: `Add dependency ${names.join(", ")}`, context: task.title, decision });
}

/** The dependency names an edit adds to a manifest, read as each manifest name the file has; undefined when the edit cannot be parsed. */
async function addedByEdit(event: any, abs: string, files: string[]) {
  const original = await read(abs);
  const next: string | undefined = event.toolName === "write" ? event.input.content ?? "" : applyEdits(original, event.input.edits ?? []);
  const added = new Set<string>();
  for (const file of files) {
    const before = dependencyNames(file, original);
    const after = next === undefined ? undefined : dependencyNames(file, next);
    if (!before || !after) return undefined;
    for (const n of after) if (!before.has(n)) added.add(n);
  }
  return [...added];
}

/** Nobody can approve a dependency in a headless run, so every new one is denied, with the reason for the model, and so is a manifest edit that cannot be checked. A plan that names a manifest does not say which package it may get, so it approves none. */
async function headlessDependency(event: any, ctx: ExtensionContext) {
  const deny = (what: string) => ({ block: true, reason: `${what}, and nobody is here to approve it. Do not add it: use what the project already has, or finish and say in your last message that the task needs it.` });
  if (event.toolName === "bash") {
    const names = addedPackagesFromCommand(event.input?.command ?? "");
    return names.length ? deny(`The new dependency ${names.join(", ")} needs approval`) : undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return;
  const { abs, names } = target(event, ctx.cwd);
  const manifests = names.filter(isManifest);
  if (!manifests.length) return;
  const file = manifests.join(", ");
  const added = await addedByEdit(event, abs, manifests);
  if (added === undefined) return deny(`This edit touches dependencies in ${file} in a way that cannot be checked`);
  if (added.length) return deny(`The new dependency ${added.join(", ")} needs approval`);
}

export function registerTriggers(pi: ExtensionAPI) {
  const approvedMigrations = new Set<string>();

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task?.status === "planning" && (event.toolName === "write" || event.toolName === "edit")) return { block: true, reason: "Planning edits nothing. Submit the plan with task_plan; edits start once it is approved." };
    if (task?.status !== "implementing") return;
    // Headless: the scope and migration gates are off; a new dependency is denied, since nobody can approve it.
    if (!ctx.hasUI) return headlessDependency(event, ctx);

    if (event.toolName === "bash") {
      const command: string = event.input?.command ?? "";
      const names = addedPackagesFromCommand(command);
      if (names.length) return approveDependency(task, ctx, "Install new package", names, `\`${command}\``);
      return;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const { abs, file, names } = target(event, ctx.cwd);
    if (names.every((n) => isPiState(n) || n.startsWith(ADR_DIR))) return;

    // The real target must be in scope; the link's own name counts only when the plan names that exact file.
    if (!inScope(task, file) && ![...(task.plan?.files ?? []), ...task.allowedExtra].includes(names.at(-1)!)) {
      // A file in the project root has no folder to allow: "./" would match nothing, and the whole project is not what the person is asked about.
      const pick = await ctx.ui.select(`The agent wants to touch a file outside the plan: ${file}`, ["Allow this file", ...(file.includes("/") ? ["Allow the whole folder"] : []), "Block"]);
      if (pick === "Allow this file" || pick === "Allow the whole folder") {
        const entry = pick === "Allow this file" ? file : `${path.posix.dirname(file)}/`;
        await updateTask(ctx.cwd, (t) => void t.allowedExtra.push(entry));
      } else return { block: true, reason: `${file} is outside the approved plan and the user blocked it. Stay within the plan files, or ask the user to extend the plan.` };
    }

    const manifests = names.filter(isManifest);
    if (manifests.length) {
      const manifest = manifests.join(", ");
      const added = await addedByEdit(event, abs, manifests);
      const blocked = added === undefined || added.length ? await approveDependency(task, ctx, added ? `New dependency in ${manifest}` : `This edit touches dependencies in ${manifest}`, added, `Edit of \`${manifest}\``) : undefined;
      if (blocked) return blocked;
    }

    const migrationKey = `${task.id}:${file}`;
    if (names.some(isMigration) && !approvedMigrations.has(migrationKey)) {
      const pick = await ctx.ui.select(`Schema change or migration: ${file}`, ["Approve", "Block"]);
      if (pick !== "Approve") return BLOCK(`the schema/migration change in ${file}`);
      approvedMigrations.add(migrationKey);
    }
  });
}
