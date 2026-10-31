import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

test("the done dialog lists every file the task changed since its base: added, modified and deleted, with their line counts", async () => {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["true"], connectors: [], understanding: "off" }),
    ".gitignore": "local.env\n",
    "a.txt": "one\ntwo\n",
    "gone.txt": "x\ny\n",
    "kept.txt": "same\n",
  });
  await sh(root, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
  const base = await new Promise<string>((resolve) => execFile("git", ["rev-parse", "HEAD"], { cwd: root }, (_e, out) => resolve(String(out).trim())));
  await fs.writeFile(path.join(root, ".pi/task.json"), JSON.stringify({ id: "t1", title: "Do it", status: "implementing", allowedExtra: [], startedAt: new Date().toISOString(), baseCommit: base }));
  const h = fakePi();
  h.pi.exec = realExec;
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const shown: string[] = [];
  const ui: any = { ...fakeUI([]), notify: () => {}, confirm: async (_title: string, message: string) => (shown.push(message), true) };
  const ctx: any = { cwd: root, hasUI: true, ui };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  // A commit made during the task still counts; so do uncommitted edits, a deletion and new untracked files.
  await sh(root, "printf 'one\\n2\\nthree\\n' > a.txt && git -c user.name=t -c user.email=t@t commit -qam 'model commit' && git rm -q gone.txt && printf 'n1\\nn2\\nn3\\n' > new.txt && printf 'b\\0in' > blob.bin && echo state > .pi/notes.txt && echo secret > local.env");
  // A new file too big to count, and a symlink, are listed without counts.
  await fs.writeFile(path.join(root, "big.txt"), "x\n".repeat(600_000));
  await sh(root, "ln -s a.txt link");
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /Files changed \(6\):\n- a\.txt \(modified, \+2 -1\)\n- big\.txt \(added\)\n- blob\.bin \(added, binary\)\n- gone\.txt \(deleted, \+0 -2\)\n- link \(added\)\n- new\.txt \(added, \+3 -0\)\n\n/);
  // Ignored files are left out, as in a commit.
  assert.doesNotMatch(shown[0], /kept\.txt|\.pi\/|local\.env/);
});
