import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BEND_INSTALL, findBend } from "./bend.ts";
import { resolveBin } from "./bin.ts";
import { desktopMissing } from "./computer/desktop.ts";
import { which } from "./computer/which.ts";
import { bundledExtension, hasGlobalSubagent } from "./subagent-ext.ts";
import { checkLimits, isObject, PREFERENCE_KEYS, readGlobal } from "./config.ts";
import { configFiles, DEFAULT_SKILLS, readManifest, readProjectManifest, UNDERSTANDING, type Manifest } from "./manifest.ts";
import { checkProfileFile } from "./self-compact/profile.ts";
import { listSkills } from "./skills.ts";
import { chromeHeadless, credentialStatus, hasNix, installMessage, NIXPKGS, nixPackage, type CredentialStatus } from "./nix.ts";

const MIN_NODE = [22, 19];

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const nodeOk = (version: string) => {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

/** What the Nix-provided binaries need to be resolved (not the same as being found on PATH). */
type Resolve = (attr: string) => Promise<string>;
export interface NixProbe {
  /** Cheap: is Nix installed. */
  has: () => Promise<boolean>;
  /** Builds or downloads the package; the first run is slow, which is why only `/doctor` does it. */
  resolve?: Resolve;
  /** The git credential helpers for github.com and whether Nix git can run them. */
  credentials?: () => Promise<CredentialStatus>;
}
/** gh comes from Nix, so a PC may have none on the shell's PATH. */
const GH_LOGIN = `\`gh auth login\` (no gh on your PATH: \`nix --extra-experimental-features 'nix-command flakes' run ${NIXPKGS}#gh -- auth login\`)`;
const realNix: NixProbe = { has: hasNix, resolve: nixPackage, credentials: () => credentialStatus() };

/** Nix itself, then (when `resolve` is given) each package it provides. A failure says what to do, not "timed out". */
async function nixChecks(nix: NixProbe, hasNix: boolean, loggedIn: () => Promise<boolean>): Promise<Check[]> {
  if (!hasNix) return [{ name: "Nix", ok: false, detail: installMessage() }];
  const checks: Check[] = [{ name: "Nix", ok: true, detail: "ok" }];
  const resolve = nix.resolve;
  if (!resolve) return checks;
  const wanted: [string, string, (r: Resolve) => Promise<string>][] = [
    ["tmux", "the subagent review and plan check run in it", (r) => r("tmux")],
    ["git", "", (r) => r("git")],
    ["gh", "/pr needs it", (r) => r("gh")],
    ["bash", "verify steps run in it", (r) => r("bash")],
    ["headless browser", "show (HTML, SVG) and the isolated browser need it", (r) => chromeHeadless(r)],
  ];
  const results = await Promise.all(wanted.map(async ([, , get]) => get(resolve).then((p) => ({ ok: true, detail: p }), (e: any) => ({ ok: false, detail: String(e?.message ?? e) }))));
  wanted.forEach(([name, why], i) => checks.push({ name, ...results[i], detail: results[i].ok ? results[i].detail : `${results[i].detail}${why ? ` (${why})` : ""}` }));
  if (nix.credentials) {
    const { configured, missing, ok } = await nix.credentials().catch(() => ({ configured: [], missing: [], ok: false }) as CredentialStatus);
    const gh = await loggedIn();
    // gh is the one login: pi-improved hands its helper to git when the configured one is not available to Nix git.
    const why = missing.length ? `the configured helper (${missing.join(", ")}) is not available to the Nix git` : configured.length ? "" : "no credential helper is configured";
    checks.push({
      name: "git credentials",
      ok: ok || gh,
      detail: ok ? `helper: ${configured.join(", ")}` : gh ? `${why ? `${why}, so ` : ""}pi-improved uses your gh login for github.com` : `${why ? `${why}. ` : ""}Run ${GH_LOGIN}: it is the one login, for git over https and for /pr`,
    });
    // A working git helper does not log gh in, and /pr needs gh after it has pushed.
    if (ok) checks.push({ name: "gh login", ok: gh, detail: gh ? "ok" : `not logged in, and /pr needs it: run ${GH_LOGIN}` });
  }
  return checks;
}

/** The `.bundled/` folder is made by the package's postinstall, which a package manager may skip. */
export const extensionDetail = (ext: string | undefined) => ext ?? "missing: without it the review never finishes. Run `npm install` in the package folder (`npm run postinstall` when npm skips install scripts)";

/** Project-file keys that are state, written by /setup and /task (`mode` is a legacy key nothing reads; it is tolerated). */
const STATE_KEYS = ["version", "setup", "language", "startedAt", "completedAt", "verify", "agentlint", "agentlintStep", "connectors", "declinedConnectors", "agentlintDeclined", "mode"];

type KeyCheck = (value: unknown) => string | undefined;
const shown = (value: unknown) => JSON.stringify(value);
const listed = (allowed: readonly string[]) => allowed.map((a) => `"${a}"`).join(", ").replace(/, ([^,]*)$/, " or $1");
const oneOf = (allowed: readonly string[]): KeyCheck => (v) => (allowed.includes(v as string) ? undefined : `${shown(v)} is not valid: use ${listed(allowed)}`);
const bool: KeyCheck = (v) => (typeof v === "boolean" ? undefined : `${shown(v)} is not valid: use true or false`);
const atLeast = (min: number): KeyCheck => (v) => (typeof v === "number" && Number.isFinite(v) && v >= min ? undefined : `must be a number >= ${min}, not ${shown(v)}`);
const object: KeyCheck = (v) => (isObject(v) ? undefined : `must be an object, not ${shown(v)}`);
type Rule = (value: unknown, key: string) => string[];
/** A rule from a check of the value alone. */
const scalar = (check: KeyCheck): Rule => (v, key) => {
  const problem = check(v);
  return problem ? [`${key}: ${problem}`] : [];
};
/** An object whose known sub-keys each have a check; an unknown sub-key is reported. */
const fields = (checks: Record<string, KeyCheck>): Rule => (value, key) =>
  !isObject(value)
    ? scalar(object)(value, key)
    : Object.entries(value).flatMap(([sub, v]) => (v === null ? [] : Object.hasOwn(checks, sub) ? scalar(checks[sub])(v, `${key}.${sub}`) : [`${key}.${sub} is not a known key: rename or remove it`]));
const modelId: KeyCheck = (v) => (typeof v === "string" && /^[^/]+\/.+/.test(v) ? undefined : `must be "provider/model-id", not ${shown(v)}`);
const globs: KeyCheck = (v) => (Array.isArray(v) && v.every((p) => typeof p === "string") ? undefined : `must be a list of globs, not ${shown(v)}`);
const choice = ["ask", "always", "never"];
/** Skill lists per phase: a phase name the code does not know is ignored, so it is reported (the Skills check reports unknown skill names). */
const phaseLists: Rule = (value, key) =>
  !isObject(value) ? scalar(object)(value, key) : Object.keys(value).filter((phase) => !Object.hasOwn(DEFAULT_SKILLS, phase)).map((phase) => `${key}.${phase} is not a known phase: use ${listed(Object.keys(DEFAULT_SKILLS))}`);

/** Per preference key, what is wrong with a value; the code reads anything else as the default without a word. `limits` has its own check, `mode` is legacy. */
const KEY_CHECKS: Record<string, Rule> = {
  models: fields({ setup: modelId, implement: modelId, review: modelId, escalate: modelId }),
  skills: phaseLists,
  skillsOnDemand: phaseLists,
  basePrompt: scalar(bool),
  useAgentlint: scalar(oneOf(choice)),
  useBend: scalar(oneOf(choice)),
  maxReport: scalar(atLeast(200)),
  understanding: scalar(oneOf(UNDERSTANDING)),
  subagentPanes: scalar(oneOf(["tern"])),
  computer: scalar(object),
  review: fields({ paths: globs, always: bool, never: bool, plan: bool, minLevel: oneOf(["off", "low", "high"]), maxLines: atLeast(0), maxFiles: atLeast(0), highLines: atLeast(0), highFiles: atLeast(0) }),
  selfCompact: (v, key) => {
    try {
      checkProfileFile(v);
      return [];
    } catch (error: any) {
      return [`${key}: ${error.message}`];
    }
  },
};

/** What is wrong with the preferences of one config file (a `null` means "unset" and is fine). */
export const settingProblems = (config: Record<string, any>): string[] =>
  PREFERENCE_KEYS.flatMap((key) => (config[key] === undefined || config[key] === null || !KEY_CHECKS[key] ? [] : KEY_CHECKS[key](config[key], key)));

/** A path as short as it can be read: relative inside the project, with `~` inside home. */
export function shortPath(file: string, cwd: string): string {
  const inside = (dir: string) => {
    const rel = path.relative(dir, file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
  };
  const rel = inside(cwd);
  if (rel) return rel;
  const home = inside(os.homedir());
  return home ? path.join("~", home) : file;
}

/** Environment checks. Never throws. `nix.resolve` is left out at session start: the first build downloads hundreds of MB, so nothing that needs Nix runs then. */
export async function runDoctor(pi: ExtensionAPI, ctx: ExtensionContext, version = process.versions.node, nix: NixProbe = realNix): Promise<Check[]> {
  const probe = async (cmd: string, args: string[]) => {
    try {
      return (await pi.exec(cmd, args, { cwd: ctx.cwd, timeout: 15_000 })).code === 0;
    } catch {
      return false;
    }
  };
  const subagent = resolveBin("subagent");
  const short = (file: string) => shortPath(file, ctx.cwd);
  const nixOk = await nix.has();
  // `subagent list` runs through Nix (tmux): at session start, with no `resolve`, that would start a build. Look the file up instead.
  const subagentOk = nix.resolve ? await probe(subagent, ["list"]) : fs.existsSync(subagent) || Boolean(which(subagent));
  const checks: Check[] = [];
  checks.push({ name: "Node", ok: nodeOk(version), detail: nodeOk(version) ? version : `${version}: needs >= ${MIN_NODE.join(".")}` });
  checks.push({ name: "subagent", ok: subagentOk, detail: subagentOk ? short(subagent) : nixOk ? "not found or not running (run `npm install` in the package folder, or reinstall with `pi install git:github.com/OnishellT/pi-improved`)" : "cannot run without Nix: install Nix first (see the Nix line)" });
  const ext = hasGlobalSubagent() ? "global" : fs.existsSync(bundledExtension()) ? "bundled" : undefined;
  checks.push({ name: "subagent extension", ok: Boolean(ext), detail: extensionDetail(ext) });
  checks.push(...(await nixChecks(nix, nixOk, () => probe("gh", ["auth", "status"]))));

  let manifest: Manifest | undefined;
  try {
    manifest = await readManifest(ctx.cwd);
  } catch (error: any) {
    checks.push({ name: "Manifest", ok: false, detail: error.message });
  }
  // The two files in effect (the project's wins), what each ignores, and limits that are wrong, named by file.
  const files = configFiles(ctx.cwd);
  let globalConfig: Record<string, any> = {};
  let globalError: string | undefined;
  try {
    globalConfig = readGlobal();
  } catch (error: any) {
    globalError = error.message;
  }
  const project = await readProjectManifest(ctx.cwd).catch(() => undefined);
  const notes: string[] = [];
  if (globalError) notes.push(`${globalError.replaceAll(files.global.file, short(files.global.file))}: the global file is ignored until it is fixed`);
  const notRead = Object.keys(globalConfig).filter((key) => !PREFERENCE_KEYS.includes(key));
  if (notRead.length) notes.push(`Not read from the global file (state or unknown keys): ${notRead.join(", ")}. Rename or remove them in ${short(files.global.file)}`);
  const unknown = Object.keys(project ?? {}).filter((key) => !PREFERENCE_KEYS.includes(key) && !STATE_KEYS.includes(key));
  if (unknown.length) notes.push(`Not read from the project file (unknown keys): ${unknown.join(", ")}. Rename or remove them in ${short(files.project.file)}`);
  const projectOnly = ["computer", "subagentPanes"].filter((key) => project && Object.hasOwn(project, key));
  if (projectOnly.length) notes.push(`${short(files.project.file)} sets ${projectOnly.join(", ")}: ignored, these are read from the global file only`);
  checks.push({
    name: "Config",
    ok: !notes.length,
    detail: `${Object.entries(files).map(([name, f]) => `${name} ${short(f.file)}${f.exists ? "" : " (not found)"}`).join("; ")}; the project file wins${notes.length ? `. ${notes.join(". ")}` : ""}`,
  });
  const problems = [
    ...checkLimits(globalConfig.limits).problems.map((p) => `${short(files.global.file)}: ${p}`),
    ...checkLimits(project?.limits).problems.map((p) => `${short(files.project.file)}: ${p}`),
  ];
  if (problems.length) checks.push({ name: "Limits", ok: false, detail: problems.join("; ") });
  const settings = [
    ...settingProblems(globalConfig).map((p) => `${short(files.global.file)}: ${p}`),
    ...settingProblems(project ?? {}).map((p) => `${short(files.project.file)}: ${p}`),
  ];
  if (settings.length) checks.push({ name: "Settings", ok: false, detail: settings.join("; ") });
  // agentlint matters only to a project whose verify or policy runs it.
  if (manifest?.agentlint || manifest?.verify?.some((c) => c.includes("agentlint"))) {
    // The project's own command, as verify and the policy run it, only when the user runs /doctor: a repo's command never runs at session start.
    const own = nix.resolve ? manifest?.agentlint : undefined;
    const agentlint = own ?? resolveBin("agentlint");
    // At session start only pi-improved's own copy runs: a bare name would be whatever the project puts on PATH.
    if (nix.resolve || path.isAbsolute(agentlint)) {
      const ok = own ? await probe("bash", ["-lc", `${own} --help`]) : await probe(agentlint, ["--help"]);
      checks.push({ name: "agentlint", ok, detail: ok ? agentlint : "not found or not running" });
    }
  }
  // Bend matters only to a project that keeps laws.
  if (await findBend(ctx.cwd)) {
    const version = await pi.exec("bash", ["-lc", "BEND_NO_TELEMETRY=1 bend version"], { cwd: ctx.cwd, timeout: 15_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : ""), () => "");
    checks.push({ name: "bend", ok: Boolean(version), detail: version || `not found, and LAWS.bend needs it: ${BEND_INSTALL}` });
  }
  // The desktop matters only once it is on (in the global file, which a synced config may carry to a machine without it).
  if (globalConfig.computer?.desktop === "on") {
    const missing = desktopMissing();
    checks.push({ name: "Desktop", ok: !missing.length, detail: missing.length ? `on, but needs: ${missing.join(", ")}` : "on" });
  }
  // Skill lists drop unknown names silently: name them here.
  const known = await listSkills();
  const skillProblems = (["skills", "skillsOnDemand"] as const).flatMap((key) =>
    Object.entries(manifest?.[key] ?? {}).flatMap(([phase, names]) =>
      !Array.isArray(names) ? [`${key}.${phase} is not a list`] : names.filter((n) => !known.includes(n)).map((n) => `${key}.${phase}: unknown skill "${n}"`),
    ),
  );
  if (skillProblems.length) checks.push({ name: "Skills", ok: false, detail: skillProblems.join("; ") });

  const wanted = Object.values(isObject(manifest?.models) ? manifest.models : {}).filter((m): m is string => typeof m === "string" && m.length > 0);
  if (wanted.length && ctx.modelRegistry) {
    const available = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
    const missing = [...new Set(wanted)].filter((m) => !available.has(m));
    checks.push({
      name: "Models",
      ok: !missing.length,
      detail: missing.length ? `unavailable: ${missing.join(", ")}. Run /login <provider> for: ${[...new Set(missing.map((m) => m.split("/")[0]))].join(", ")}` : "listed for a logged-in provider (not called)",
    });
  }
  return checks;
}

/** Checks about the user's config files, not the machine. */
const CONFIG_CHECKS = ["Manifest", "Config", "Limits", "Settings", "Skills"];

let warned = false;

export function registerDoctor(pi: ExtensionAPI, nix: NixProbe = realNix) {
  pi.registerCommand("doctor", {
    description: "Check that the environment has everything pi-improved needs (the first run downloads the Nix packages)",
    handler: async (_args, ctx) => {
      // The first run builds or downloads the Nix packages, which takes minutes: say so while it runs.
      ctx.ui.setStatus?.("doctor", "doctor: checking... the first run downloads tmux, git, gh, bash and the headless browser (minutes)");
      let checks: Check[];
      try {
        checks = await runDoctor(pi, ctx, undefined, nix);
      } finally {
        ctx.ui.setStatus?.("doctor", undefined);
      }
      // A heading first: the notice level's prefix ("Warning:") lands on it, not on the first check.
      const bad = checks.filter((c) => !c.ok).length;
      const heading = `pi-improved doctor: ${bad ? `${bad} problem${bad === 1 ? "" : "s"}` : "all checks pass"}`;
      ctx.ui.notify([heading, ...checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)].join("\n"), bad ? "warning" : "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    const bad = (await runDoctor(pi, ctx, undefined, { has: nix.has })).filter((c) => !c.ok);
    if (!bad.length) return;
    // A typo in a config file is not "missing": name which side is wrong.
    const names = (config: boolean) => bad.filter((c) => CONFIG_CHECKS.includes(c.name) === config).map((c) => c.name);
    const parts = [names(true).length && `your config has problems (${names(true).join(", ")})`, names(false).length && `missing or not working: ${names(false).join(", ")}`].filter(Boolean);
    ctx.ui.notify(`pi-improved: ${parts.join("; ")}. Run /doctor to see what to fix.`, "warning");
  });
}
