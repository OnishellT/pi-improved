import assert from "node:assert/strict";
import { test } from "node:test";
import { detectConnectors } from "../src/connectors.ts";
import { resolveBin } from "../src/bin.ts";
import { agentlintCmd, discover, isProject } from "../src/discover.ts";
import { tempProject } from "./helpers.ts";

const noGit = async () => "";

test("node + typescript project proposes package scripts with the right package manager", async () => {
  const root = await tempProject({
    "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", dev: "vite" } }),
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
    ".github/workflows/ci.yml": "",
    "README.md": "# app",
  });
  const found = await discover(root, noGit);
  assert.deepEqual(found.stacks, ["node", "typescript"]);
  assert.equal(found.packageManager, "pnpm");
  assert.deepEqual(found.verify, ["pnpm tsc --noEmit", "pnpm run lint", "pnpm run test"]);
  assert.deepEqual(found.ci, [".github/workflows/ci.yml"]);
  assert.deepEqual(found.docs, ["README.md"]);
});

test("an existing verify entry point wins over individual checks", async () => {
  const root = await tempProject({ "go.mod": "module x", Makefile: "test:\n\tgo test\nverify: test\n\tgo vet\n" });
  assert.deepEqual((await discover(root, noGit)).verify, ["make verify"]);
});

test("a configured agentlint gate is appended to the verify steps", async () => {
  const root = await tempProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "pnpm-lock.yaml": "", ".agentlint/config.ts": "" });
  assert.deepEqual((await discover(root, noGit)).verify, ["pnpm run test", "pnpm agentlint check --all"]);
});

test("agentlint uses the project's package manager", async () => {
  const found = await discover(await tempProject({ "package.json": "{}", "pnpm-lock.yaml": "" }), noGit);
  assert.equal(agentlintCmd(found.packageManager), "pnpm agentlint");
});

test("python checks come from pyproject tool sections", async () => {
  const root = await tempProject({ "pyproject.toml": "[tool.ruff]\n[tool.pytest.ini_options]\n" });
  assert.deepEqual((await discover(root, noGit)).verify, ["ruff check .", "pytest -q"]);
});

test("connector signals come from remotes, commit keys and docs", () => {
  const signals = detectConnectors({
    remotes: "origin\tgit@github.com:acme/app.git (fetch)",
    commits: "PAY-142 fix rounding\nchore: deps",
    docs: "Ask in https://acme.slack.com/archives/C1",
  });
  assert.deepEqual(signals.map((s) => s.id), ["github", "jira", "slack"]);
  assert.match(signals[1].evidence, /PAY-142/);
});

test("ticket keys are not attributed to Jira when the docs point to Linear", () => {
  const signals = detectConnectors({ remotes: "", commits: "ENG-7 add login", docs: "Board: https://linear.app/acme" });
  assert.deepEqual(signals.map((s) => s.id), ["linear"]);
});

test("isProject needs a git repo or a stack marker", async () => {
  assert.equal(await isProject(await tempProject({ "notes.txt": "" })), false);
  assert.equal(await isProject(await tempProject({ "Cargo.toml": "" })), true);
});

test("a malformed package.json does not crash discovery", async () => {
  const { readPackageJson } = await import("../src/discover.ts");
  const root = await tempProject({ "package.json": "{ not json", "tsconfig.json": "{}" });
  assert.deepEqual(await readPackageJson(root), {});
  assert.deepEqual(await readPackageJson(await tempProject({ "package.json": "null" })), {});
  const found = await discover(root, noGit);
  assert.ok(Array.isArray(found.verify));
});
