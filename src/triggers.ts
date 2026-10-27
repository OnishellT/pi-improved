import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAdr } from "./adr.ts";
import { inScope, isPiState, readTask, updateTask, type Task } from "./task-state.ts";

const ADR_DIR = "docs/adr/";
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/;
const MIGRATION = /(^|\/)(migrations?\/|db\/migrate\/|alembic\/versions\/)|(^|\/)schema\.prisma$|\.sql$/;
const INSTALLERS = /^(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)|(?:python3?\s+-m\s+)?pip3?\s+install|uv\s+(?:pip\s+install|add)|poetry\s+add|go\s+get|cargo\s+add|gem\s+install|composer\s+require)\s+(.+)$/;

export const toRelative = (cwd: string, p: string) => path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join("/");
export const isMigration = (p: string) => MIGRATION.test(p);
export const isManifest = (p: string) => MANIFEST.test(p);

/** Package names a shell command installs; bare installs and `-r`/`-e` installs yield none. */
export function addedPackagesFromCommand(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const args = INSTALLERS.exec(segment.trim())?.[1].split(/\s+/);
    if (!args || args.some((a) => /^(-r|-e|--requirement|--editable)$/.test(a))) continue;
    for (const a of args) {
      if (!a || a.startsWith("-") || /^[./~]/.test(a) || a.includes("=") && !/[<>~!]=/.test(a) && !a.includes("==")) continue;
      names.push(a.replace(/^(@?[^@=<>~!\[]+).*$/, "$1"));
    }
  }
  return [...new Set(names)];
}

const quoted = (line: string) => [...line.matchAll(/["']([A-Za-z0-9_.-]+)[^"']*["']/g)].map((m) => m[1].toLowerCase());

function tomlNames(content: string, python: boolean) {
  const names = new Set<string>();
  let section = "";
  let inArray = false;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) {
      section = header[1].trim();
      inArray = false;
      const sub = /dependencies\.([\w.-]+)$/.exec(section);
      if (sub) names.add(sub[1]);
      continue;
    }
    const depSection = /(^|[.-])dependencies$/.test(section) || section === "dependency-groups";
    if (inArray || (python && /^(dependencies|[\w.-]+)\s*=\s*\[/.test(line) && (depSection || /^dependencies\s*=/.test(line)))) {
      quoted(line.replace(/^[\w.-]+\s*=\s*/, "")).forEach((n) => names.add(n));
      inArray = !line.includes("]");
    } else if (depSection) {
      const key = /^([\w.-]+)\s*=/.exec(line)?.[1];
      if (key && key !== "python") names.add(key);
    }
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
  if (base.endsWith(".txt")) return new Set(content.split("\n").map((l) => /^([A-Za-z0-9_.-]+)/.exec(l.trim())?.[1]?.toLowerCase()).filter(Boolean) as string[]);
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

export function registerTriggers(pi: ExtensionAPI) {
  const approvedMigrations = new Set<string>();

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return; // headless: the scope, dependency and migration gates are off
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task?.status !== "implementing") return;

    if (event.toolName === "bash") {
      const command: string = event.input?.command ?? "";
      const names = addedPackagesFromCommand(command);
      if (names.length) return approveDependency(task, ctx, "Install new package", names, `\`${command}\``);
      return;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const abs = path.resolve(ctx.cwd, event.input?.path ?? "");
    const file = toRelative(ctx.cwd, abs);
    if (isPiState(file) || file.startsWith(ADR_DIR)) return;

    if (!inScope(task, file)) {
      const pick = await ctx.ui.select(`The agent wants to touch a file outside the plan: ${file}`, ["Allow this file", "Allow the whole folder", "Block"]);
      if (pick === "Allow this file" || pick === "Allow the whole folder") {
        const entry = pick === "Allow this file" ? file : `${path.posix.dirname(file)}/`;
        await updateTask(ctx.cwd, (t) => void t.allowedExtra.push(entry));
      } else return { block: true, reason: `${file} is outside the approved plan and the user blocked it. Stay within the plan files, or ask the user to extend the plan.` };
    }

    if (isManifest(file)) {
      const before = dependencyNames(file, await read(abs));
      let after: Set<string> | undefined;
      if (event.toolName === "write") after = dependencyNames(file, event.input.content ?? "");
      else {
        const next = applyEdits(await read(abs), event.input.edits ?? []);
        after = next === undefined ? undefined : dependencyNames(file, next);
      }
      const added = before && after ? [...after].filter((n) => !before.has(n)) : undefined;
      if (added === undefined || added.length) return approveDependency(task, ctx, added ? `New dependency in ${file}` : `This edit touches dependencies in ${file}`, added, `Edit of \`${file}\``);
    }

    const migrationKey = `${task.id}:${file}`;
    if (isMigration(file) && !approvedMigrations.has(migrationKey)) {
      const pick = await ctx.ui.select(`Schema change or migration: ${file}`, ["Approve", "Block"]);
      if (pick !== "Approve") return BLOCK(`the schema/migration change in ${file}`);
      approvedMigrations.add(migrationKey);
    }
  });
}
