import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { registerGate } from "../src/gate.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const sh = (cwd: string, script: string) => new Promise<void>((resolve, reject) => execFile("bash", ["-c", script], { cwd }, (e) => (e ? reject(e) : resolve())));
const realExec = (cmd: string, args: string[], o: { cwd: string }) =>
  new Promise((resolve) => execFile(cmd, args, { cwd: o.cwd }, (e: any, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: e ? (typeof e.code === "number" ? e.code : 1) : 0, killed: false })));

async function project() {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["echo BROKEN >&2; exit 1"], connectors: [] }),
    "a.txt": "one\n",
  });
  await sh(root, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
  const h = fakePi();
  h.pi.exec = realExec;
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const ctx: any = { cwd: root, hasUI: false, ui: fakeUI([]) };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  return { root, h, ctx };
}

test("an edit made through bash is gated", async () => {
  const { root, h, ctx } = await project();
  await sh(root, "echo two >> a.txt");
  assert.equal((await h.emit("agent_before_settle", { outcome: "completed" }, ctx))?.continue, true);
});

test("the same edit committed through bash is gated too: a new commit is a change", async () => {
  const { root, h, ctx } = await project();
  await sh(root, "echo two >> a.txt && git -c user.name=t -c user.email=t@t commit -qam 'model commit'");
  assert.equal((await h.emit("agent_before_settle", { outcome: "completed" }, ctx))?.continue, true);
});

test("no change at all is not gated", async () => {
  const { h, ctx } = await project();
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }, ctx), undefined);
});
