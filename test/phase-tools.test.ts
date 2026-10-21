import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import extension from "../src/index.ts";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { registerGuards } from "../src/guards.ts";
import { registerPhaseTools } from "../src/phase-tools.ts";
import { registerSetup } from "../src/setup.ts";
import { writeTask } from "../src/task-state.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

test("phase tools are visible only during their phase", async () => {
  const root = await tempProject({});
  const { pi, emit } = fakePi();
  let active = ["read", "setup_finish", "task_plan"];
  pi.getActiveTools = () => active;
  pi.setActiveTools = (names: string[]) => void (active = names);
  registerPhaseTools(pi);

  await emit("before_agent_start", { messageType: "user" }, { cwd: root });
  assert.deepEqual(active, ["read"]);

  await updateManifest(root, (m) => void (m.setup = "running"));
  await emit("before_agent_start", { messageType: "user" }, { cwd: root });
  assert.deepEqual(active.sort(), ["read", "setup_finish"]);

  await updateManifest(root, (m) => void (m.setup = "done"));
  await writeTask(root, { id: "t", title: "x", status: "planning", allowedExtra: [], startedAt: "" });
  await emit("turn_end", {}, { cwd: root });
  assert.deepEqual(active.sort(), ["read", "task_plan"]);
});

test("the extension registers nothing inside a subagent child", () => {
  const { pi, tools, commands } = fakePi();
  process.env.PI_SUBAGENT_RUN_DIR = "/tmp/run";
  try {
    extension(pi);
  } finally {
    delete process.env.PI_SUBAGENT_RUN_DIR;
  }
  assert.equal(tools.size + commands.size, 0);
});

test("an agentlint config with zero rules does not block setup", async () => {
  const root = await tempProject({
    "AGENTS.md": "# App\n",
    "GLOSSARY.md": "# G\n",
    ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing\n---\n",
    ".agentlint/config.ts": "",
  });
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "npm exec agentlint --";
  });
  const { pi, tools } = fakePi((_cmd, args) => (/rules test/.test(args[1]) ? { code: 2, stderr: "No matching rules. Available:" } : { code: 0 }));
  registerSetup(pi);
  const ui = fakeUI([true]);
  const result = await tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, { cwd: root, hasUI: true, ui });
  assert.equal(result.terminate, true);
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /\.pi\/task\.json/);
});

test("agentlint commands that open the review UI are blocked", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const call = (command: string) => emit("tool_call", { toolName: "bash", input: { command } }, { cwd: "/" });
  assert.equal((await call("npm exec agentlint -- rules scan --review"))?.block, true);
  assert.equal((await call("pnpm agentlint review"))?.block, true);
  assert.equal(await call("npm exec agentlint -- rules scan && npm test"), undefined);
  // A rule id that contains "review" or "accept" is not the subcommand.
  assert.equal(await call("npm exec agentlint -- explain facturas/tax-calculation-review"), undefined);
  assert.equal(await call("pnpm agentlint check --rule payments/accept-terms"), undefined);
});

test("setup_finish does not add agentlint twice when a package script already runs it", async () => {
  const root = await tempProject({
    "AGENTS.md": "# App\n",
    "GLOSSARY.md": "# G\n",
    ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing\n---\n",
    ".agentlint/config.ts": "",
    "package.json": JSON.stringify({ scripts: { verify: "npm test && npm exec agentlint -- check --all" } }),
  });
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "npm exec agentlint --";
  });
  const { pi, tools } = fakePi();
  registerSetup(pi);
  await tools.get("setup_finish").execute("1", { verify: ["npm run verify"], summary: "s" }, undefined, undefined, { cwd: root, hasUI: true, ui: fakeUI([true]) });
  assert.deepEqual((await readManifest(root)).verify, ["npm run verify"]);
});

test("an agentlint exception needs the user's approval", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const call = (answer: string) =>
    emit("tool_call", { toolName: "bash", input: { command: 'npm exec agentlint -- accept 1 --reason "ok"' } }, { cwd: "/", hasUI: true, ui: fakeUI([answer]) });
  assert.equal((await call("Bloquear: que lo corrija"))?.block, true);
  assert.equal(await call("Aprobar la excepción"), undefined);
});

test("the model cannot rewrite the workflow state files", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const write = (p: string) => emit("tool_call", { toolName: "write", input: { path: p, content: "{}" } }, { cwd: "/" });
  assert.equal((await write(".pi/workflow.json"))?.block, true);
  assert.equal((await write("/repo/.pi/task.json"))?.block, true);
  assert.equal(await write(".pi/skills/domain-x/SKILL.md"), undefined);
});

test("phase tools leave the declared tools alone when nothing changes", async () => {
  const root = await tempProject({});
  const { pi, emit } = fakePi();
  let calls = 0;
  pi.getActiveTools = () => ["read"];
  pi.setActiveTools = () => void calls++;
  registerPhaseTools(pi);
  await emit("turn_end", {}, { cwd: root });
  await emit("before_agent_start", { messageType: "user" }, { cwd: root });
  assert.equal(calls, 0);
});
