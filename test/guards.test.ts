import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { registerGuards } from "../src/guards.ts";
import { fakePi, fakeUI } from "./helpers.ts";

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

test("the workflow state files are blocked for write and edit, even through ./ segments", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const call = (toolName: string, p: string) => emit("tool_call", { toolName, input: { path: p } }, { cwd: "/" });
  for (const p of [".pi/workflow.json", ".pi/./workflow.json", "sub/../.pi/task.json"]) assert.equal((await call("write", p))?.block, true, p);
  assert.equal(await call("edit", "src/a.ts"), undefined);
});

test("a symlink to the global config or a workflow state file is blocked like the file itself", async () => {
  const { globalPath } = await import("../src/config.ts");
  const { mkdtempSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
  mkdirSync(join(dir, ".pi"));
  symlinkSync(globalPath(), join(dir, "alias.json"));
  symlinkSync(dirname(globalPath()), join(dir, "agent"));
  symlinkSync(join(dir, ".pi", "task.json"), join(dir, "state.json"));
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const write = (p: string) => emit("tool_call", { toolName: "write", input: { path: p, content: "{}" } }, { cwd: dir });
  // pi strips a leading @ and turns Unicode spaces into plain ones before it opens the file.
  for (const p of ["alias.json", "agent/pi-improved.json", "state.json", "@alias.json", "@.pi/task.json", `file://${join(dir, "alias.json")}`, `file://${join(dir, ".pi/task.json")}`]) assert.equal((await write(p))?.block, true, p);
  assert.equal(await write("other.json"), undefined);
});

test("an agentlint exception needs the user's approval", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const call = (answer: string) =>
    emit("tool_call", { toolName: "bash", input: { command: 'npm exec agentlint -- accept 1 --reason "ok"' } }, { cwd: "/", hasUI: true, ui: fakeUI([answer]) });
  assert.equal((await call("Block: make it fix the code"))?.block, true);
  assert.equal(await call("Approve the exception"), undefined);
});

test("the model cannot rewrite the workflow state files", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const write = (p: string) => emit("tool_call", { toolName: "write", input: { path: p, content: "{}" } }, { cwd: "/" });
  assert.equal((await write(".pi/workflow.json"))?.block, true);
  assert.equal((await write("/repo/.pi/task.json"))?.block, true);
  assert.equal(await write(".pi/skills/domain-x/SKILL.md"), undefined);
});
