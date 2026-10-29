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

test("an edit of the acceptances file points the agent at propose, not accept", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const r = await emit("tool_call", { toolName: "edit", input: { path: ".agentlint/acceptances.jsonl" } }, { cwd: "/" });
  assert.equal(r?.block, true);
  assert.match(r.reason, /agentlint propose <selector> --summary.*agentlint next --format json/);
  assert.doesNotMatch(r.reason, /agentlint accept/);
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

/** A project dir and a bash call whose "command" is a function that changes the acceptances file, like any command could. */
async function acceptances(ui?: ReturnType<typeof fakeUI>) {
  const fs = await import("node:fs/promises");
  const { mkdtemp } = fs;
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-accept-"));
  const file = join(dir, ".agentlint", "acceptances.jsonl");
  const { pi, emit } = fakePi();
  registerGuards(pi);
  let id = 0;
  const ctx = { cwd: dir, hasUI: !!ui, ui };
  const bash = async (command: string, effect: () => Promise<unknown>) => {
    const call = { toolName: "bash", toolCallId: String(++id), input: { command } };
    assert.equal(await emit("tool_call", call, ctx), undefined);
    await effect();
    return emit("tool_result", { ...call, content: [{ type: "text", text: "done" }], isError: false }, ctx);
  };
  const write = async (text: string) => (await fs.mkdir(join(dir, ".agentlint"), { recursive: true }), fs.writeFile(file, text));
  const content = () => fs.readFile(file, "utf8").catch(() => undefined);
  return { bash, write, content, file, emit, dir };
}

test("an agentlint exception the user approves stays, and they see the new record", async () => {
  const ui = fakeUI([true]);
  const shown: string[] = [];
  const confirm = ui.confirm;
  (ui as any).confirm = (title: string, body: string) => (shown.push(body), confirm(title));
  const { bash, write, content } = await acceptances(ui);
  await write('{"id":"old"}\n');
  assert.equal(await bash("npm exec agentlint -- accept 1 --reason 'ok'", () => write('{"id":"old"}\n{"id":"new"}\n')), undefined);
  assert.deepEqual(shown, ['{"id":"new"}'], "only the new line is shown");
  assert.equal(await content(), '{"id":"old"}\n{"id":"new"}\n');
  // A command that adds nothing (or only removes stale records) asks nothing.
  assert.equal(await bash("npm test", () => write("")), undefined);
});

test("a declined or unapprovable exception is undone, however the command was spelled", async () => {
  const declined = await acceptances(fakeUI([false]));
  await declined.write('{"id":"old"}\n');
  const r = await declined.bash("x=accept; agentlint $x 1 --reason 'ok'", () => declined.write('{"id":"old","reason":"changed"}\n'));
  assert.match(r.content.at(-1).text, /did not accept.*restored/);
  assert.equal(await declined.content(), '{"id":"old"}\n');

  const headless = await acceptances();
  const h = await headless.bash("npm run lint:accept", () => headless.write('{"id":"new"}\n'));
  assert.match(h.content.at(-1).text, /need the user's approval.*restored/);
  assert.equal(await headless.content(), undefined, "a file that did not exist is removed again");
});

test("an exception written after its command returned is caught by the next check", async () => {
  const { bash, write, content } = await acceptances(fakeUI([false]));
  // A background process: the command returns first, the record lands later.
  assert.equal(await bash("(sleep 1; agentlint accept 1 --reason 'x') &", async () => {}), undefined);
  await write('{"id":"late"}\n');
  const r = await bash("ls", async () => {});
  assert.match(r.content.at(-1).text, /did not accept.*restored/);
  assert.equal(await content(), undefined);
});

test("an exception taken out and written again is asked again", async () => {
  const { bash, write, content } = await acceptances(fakeUI([true, false]));
  await bash("agentlint accept 1 --reason 'x'", () => write('{"id":"x"}\n'));
  await bash("agentlint acceptances clean", () => write(""));
  const r = await bash("agentlint accept 1 --reason 'x'", () => write('{"id":"x"}\n'));
  assert.match(r.content.at(-1).text, /did not accept.*restored/);
  assert.equal(await content(), undefined);
});

test("the model cannot write or edit the acceptances file", async () => {
  const { emit, dir } = await acceptances();
  for (const [toolName, p] of [["write", ".agentlint/acceptances.jsonl"], ["edit", "./.agentlint/../.agentlint/acceptances.jsonl"]])
    assert.equal((await emit("tool_call", { toolName, input: { path: p } }, { cwd: dir }))?.block, true, p);
});

test("the model cannot rewrite the workflow state files", async () => {
  const { pi, emit } = fakePi();
  registerGuards(pi);
  const write = (p: string) => emit("tool_call", { toolName: "write", input: { path: p, content: "{}" } }, { cwd: "/" });
  assert.equal((await write(".pi/workflow.json"))?.block, true);
  assert.equal((await write("/repo/.pi/task.json"))?.block, true);
  assert.equal(await write(".pi/skills/domain-x/SKILL.md"), undefined);
});
