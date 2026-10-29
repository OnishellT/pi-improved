import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BEND_INSTALL, findBend } from "./bend.ts";
import { resolveBin } from "./bin.ts";
import { which } from "./computer/which.ts";
import { bundledExtension, hasGlobalSubagent } from "./subagent-ext.ts";
import { checkLimits, PREFERENCE_KEYS, readGlobal } from "./config.ts";
import { configFiles, readManifest, readProjectManifest } from "./manifest.ts";
import { chromeHeadless, credentialStatus, hasNix, installMessage, nixPackage, type CredentialStatus } from "./nix.ts";

const MIN_NODE = [22, 18];

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
const realNix: NixProbe = { has: hasNix, resolve: nixPackage, credentials: () => credentialStatus() };

/** Nix itself, then (when `resolve` is given) each package it provides. A failure says what to do, not "timed out". */
async function nixChecks(nix: NixProbe, loggedIn: () => Promise<boolean>): Promise<Check[]> {
  if (!(await nix.has())) return [{ name: "Nix", ok: false, detail: installMessage() }];
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
      detail: ok ? `helper: ${configured.join(", ")}` : gh ? `${why ? `${why}, so ` : ""}pi-improved uses your gh login for github.com` : `${why ? `${why}. ` : ""}Run \`gh auth login\`: it is the one login, for git over https and for /pr`,
    });
  }
  return checks;
}

/** The `.bundled/` folder is made by the package's postinstall, which a package manager may skip. */
export const extensionDetail = (ext: string | undefined) => ext ?? "missing: without it the review never finishes. Run `node scripts/postinstall.mjs` in the package folder to fetch it";

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
  // `subagent list` runs through Nix (tmux): at session start, with no `resolve`, that would start a build. Look the file up instead.
  const subagentOk = nix.resolve ? await probe(subagent, ["list"]) : fs.existsSync(subagent) || Boolean(which(subagent));
  const checks: Check[] = [];
  checks.push({ name: "Node", ok: nodeOk(version), detail: nodeOk(version) ? version : `${version}: needs >= ${MIN_NODE.join(".")}` });
  checks.push({ name: "subagent", ok: subagentOk, detail: subagentOk ? subagent : "not found or not running (reinstall with `pi install git:github.com/OnishellT/pi-improved`)" });
  const ext = hasGlobalSubagent() ? "global" : fs.existsSync(bundledExtension()) ? "bundled" : undefined;
  checks.push({ name: "subagent extension", ok: Boolean(ext), detail: extensionDetail(ext) });
  checks.push(...(await nixChecks(nix, () => probe("gh", ["auth", "status"]))));

  let manifest;
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
  if (globalError) notes.push(`${globalError}: the global file is ignored until it is fixed`);
  const notRead = Object.keys(globalConfig).filter((key) => !PREFERENCE_KEYS.includes(key));
  if (notRead.length) notes.push(`Not read from the global file (state or unknown keys): ${notRead.join(", ")}`);
  const projectOnly = ["computer", "subagentPanes"].filter((key) => project && Object.hasOwn(project, key));
  if (projectOnly.length) notes.push(`${files.project.file} sets ${projectOnly.join(", ")}: ignored, these are read from the global file only`);
  checks.push({
    name: "Config",
    ok: !notes.length,
    detail: `${Object.entries(files).map(([name, f]) => `${name} ${f.file}${f.exists ? "" : " (not found)"}`).join("; ")}; the project file wins${notes.length ? `. ${notes.join(". ")}` : ""}`,
  });
  const problems = [
    ...checkLimits(globalConfig.limits).problems.map((p) => `${files.global.file}: ${p}`),
    ...checkLimits(project?.limits).problems.map((p) => `${files.project.file}: ${p}`),
  ];
  if (problems.length) checks.push({ name: "Limits", ok: false, detail: problems.join("; ") });
  // agentlint matters only to a project whose verify or policy runs it.
  if (manifest?.agentlint || manifest?.verify?.some((c) => c.includes("agentlint"))) {
    const agentlint = resolveBin("agentlint");
    const ok = await probe(agentlint, ["--help"]);
    checks.push({ name: "agentlint", ok, detail: ok ? agentlint : "not found or not running" });
  }
  // Bend matters only to a project that keeps laws.
  if (await findBend(ctx.cwd)) {
    const version = await pi.exec("bash", ["-lc", "BEND_NO_TELEMETRY=1 bend version"], { cwd: ctx.cwd, timeout: 15_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : ""), () => "");
    checks.push({ name: "bend", ok: Boolean(version), detail: version || `not found, and LAWS.bend needs it: ${BEND_INSTALL}` });
  }
  const mode = manifest?.mode;
  if (mode !== undefined) {
    const modeOk = mode === "direct" || mode === "flow";
    checks.push({ name: "Mode", ok: modeOk, detail: modeOk ? mode : `"${String(mode)}" is not valid in .pi/workflow.json: use "direct" or "flow"` });
  }

  const wanted = Object.values(manifest?.models ?? {}).filter((m): m is string => Boolean(m));
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

let warned = false;

export function registerDoctor(pi: ExtensionAPI, nix: NixProbe = realNix) {
  pi.registerCommand("doctor", {
    description: "Check that the environment has everything pi-improved needs (the first run downloads the Nix packages)",
    handler: async (_args, ctx) => {
      const checks = await runDoctor(pi, ctx, undefined, nix);
      ctx.ui.notify(checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n"), checks.every((c) => c.ok) ? "info" : "warning");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    const bad = (await runDoctor(pi, ctx, undefined, { has: nix.has })).filter((c) => !c.ok);
    if (bad.length) ctx.ui.notify(`Something is missing in the environment (${bad.map((c) => c.name).join(", ")}). Run /doctor.`, "warning");
  });
}
