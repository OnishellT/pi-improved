import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bendCheck, findBend, type BendProject } from "./bend.ts";
import { detectConnectors, type ConnectorSignal } from "./connectors.ts";
import { detectUiDrivers } from "./ui-driver.ts";

/** Runs a command and returns stdout, or "" when it fails. */
export type Run = (command: string, args: string[]) => Promise<string>;

export interface Discovery {
  stacks: string[];
  packageManager?: string;
  /** Proposed verify steps, in the order they should run. */
  verify: string[];
  ci: string[];
  docs: string[];
  agentFiles: string[];
  /** `.agentlint/config.*` already exists. */
  agentlint: boolean;
  connectors: ConnectorSignal[];
  /** GLOSSARY.md exists at the repo root. */
  glossary: boolean;
  /** docs/agents/ exists. */
  agentDocs: boolean;
  /** Ids of the GUI drivers the verify-app script can use (on PATH, or the desktop /computer turned on). Absent when none. */
  uiDrivers?: string[];
  /** The project keeps Bend laws (LAWS.bend). Absent otherwise. */
  bend?: BendProject;
}

const STACK_MARKERS: [string, string][] = [
  ["package.json", "node"],
  ["tsconfig.json", "typescript"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "kotlin"],
  ["Gemfile", "ruby"],
  ["composer.json", "php"],
];

const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

const DOC_CANDIDATES = ["README.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "docs", "docs/adr", "adr"];
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md", ".pi/skills"];
const CHECK_SCRIPTS = ["typecheck", "lint", "test", "build"];

const exists = (file: string) => fs.access(file).then(() => true, () => false);
const readText = (file: string) => fs.readFile(file, "utf8").catch(() => "");

/** The project's package.json, or {} when it is missing or not valid JSON. */
export async function readPackageJson(root: string): Promise<any> {
  try {
    const pkg = JSON.parse(await readText(path.join(root, "package.json")));
    return pkg && typeof pkg === "object" ? pkg : {};
  } catch {
    return {};
  }
}

async function present(root: string, names: string[]) {
  const hits = await Promise.all(names.map(async (name) => ((await exists(path.join(root, name))) ? name : undefined)));
  return hits.filter((name): name is string => name !== undefined);
}

async function makeTargets(root: string): Promise<{ tool: string; targets: string[] } | undefined> {
  for (const [file, tool] of [["justfile", "just"], ["Justfile", "just"], ["Makefile", "make"]]) {
    const text = await readText(path.join(root, file));
    if (text) return { tool, targets: [...text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]) };
  }
  return undefined;
}

async function proposeVerify(root: string, stacks: string[], pm: string | undefined): Promise<string[]> {
  const make = await makeTargets(root);
  if (make?.targets.includes("verify")) return [`${make.tool} verify`];

  const scripts: Record<string, string> = (await readPackageJson(root)).scripts ?? {};
  const runner = pm ?? "npm";
  if (scripts.verify) return [`${runner} run verify`];

  const steps: string[] = [];
  for (const name of CHECK_SCRIPTS) if (scripts[name]) steps.push(`${runner} run ${name}`);
  if (stacks.includes("typescript") && !scripts.typecheck && !Object.values(scripts).some((s) => /\btsc\b/.test(s))) {
    steps.unshift(`${runner === "npm" ? "npx" : runner} tsc --noEmit`);
  }
  if (stacks.includes("go")) steps.push("go vet ./...", "go test ./...");
  if (stacks.includes("rust")) steps.push("cargo clippy --all-targets", "cargo test");
  if (stacks.includes("python")) {
    const pyproject = await readText(path.join(root, "pyproject.toml"));
    if (/\[tool\.ruff/.test(pyproject)) steps.push("ruff check .");
    if (/\[tool\.mypy/.test(pyproject)) steps.push("mypy .");
    if (/\[tool\.pytest/.test(pyproject) || (await exists(path.join(root, "tests")))) steps.push("pytest -q");
  }
  if (!steps.length && make) for (const target of ["check", "lint", "test"]) if (make.targets.includes(target)) steps.push(`${make.tool} ${target}`);
  return [...steps, ...(await agentlintStep(root, pm))];
}

const AGENTLINT_CMD: Record<string, string> = { npm: "npm exec agentlint --", pnpm: "pnpm agentlint", yarn: "yarn agentlint", bun: "bun run agentlint" };
export const agentlintCmd = (pm: string | undefined) => AGENTLINT_CMD[pm ?? "npm"] ?? AGENTLINT_CMD.npm;
export const agentlintCheck = (cmd: string) => `${cmd} check --all`;

export async function hasAgentlintConfig(root: string) {
  const files = await fs.readdir(path.join(root, ".agentlint")).catch(() => [] as string[]);
  return files.some((f) => /^config\.[cm]?[jt]s$/.test(f));
}

/** agentlint is a deterministic rule gate; once configured, it runs as one more verify step. */
async function agentlintStep(root: string, pm: string | undefined) {
  return (await hasAgentlintConfig(root)) ? [agentlintCheck(agentlintCmd(pm))] : [];
}

/** Deterministic repository scan: no model involved. */
export async function discover(root: string, run: Run, pathEnv?: string): Promise<Discovery> {
  const markers = await present(root, STACK_MARKERS.map(([f]) => f));
  const stacks = [...new Set(STACK_MARKERS.filter(([f]) => markers.includes(f)).map(([, stack]) => stack))];
  const lockfile = stacks.includes("node") ? (await present(root, LOCKFILES.map(([f]) => f)))[0] : undefined;
  const packageManager = stacks.includes("node") ? (LOCKFILES.find(([f]) => f === lockfile)?.[1] ?? "npm") : undefined;

  const ci = [
    ...(await fs.readdir(path.join(root, ".github/workflows")).catch(() => [] as string[])).map((f) => `.github/workflows/${f}`),
    ...(await present(root, [".gitlab-ci.yml", "bitbucket-pipelines.yml", ".circleci/config.yml", "azure-pipelines.yml"])),
  ];
  const docs = await present(root, DOC_CANDIDATES);
  const agentFiles = await present(root, AGENT_FILES);

  const docText = (await Promise.all(["README.md", "CONTRIBUTING.md", "package.json"].map((f) => readText(path.join(root, f))))).join("\n");
  const connectors = detectConnectors({
    remotes: await run("git", ["-C", root, "remote", "-v"]),
    commits: await run("git", ["-C", root, "log", "-200", "--format=%s"]),
    docs: docText,
  });

  const agentlint = await hasAgentlintConfig(root);
  const uiDrivers = await detectUiDrivers(pathEnv);
  const bend = await findBend(root);
  // Verify runs in a login shell, so that shell's PATH decides, not ours.
  if (bend) bend.installed = Boolean((await run("bash", ["-lc", "command -v bend"])).trim());
  const verify = await proposeVerify(root, stacks, packageManager);
  // A proof check only runs when bend can: a missing binary would fail verify for a reason the agent cannot fix.
  if (bend?.proof && bend.installed) verify.push(bendCheck(bend.proof));
  return { stacks, packageManager, verify, ci, docs, agentFiles, agentlint, connectors, glossary: await exists(path.join(root, "GLOSSARY.md")), agentDocs: await exists(path.join(root, "docs/agents")), ...(uiDrivers.length ? { uiDrivers } : {}), ...(bend ? { bend } : {}) };
}

/** A directory looks like a project when it is a git repo or has a stack marker. */
export async function isProject(root: string) {
  return (await present(root, [".git", ...STACK_MARKERS.map(([f]) => f)])).length > 0;
}
