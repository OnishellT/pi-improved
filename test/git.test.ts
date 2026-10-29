import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFiles, diffBase, EMPTY_TREE, git, gitHead, untrackedFiles } from "../src/git.ts";

const reply = (stdout: string, code = 0, killed = false): any => async () => ({ stdout, stderr: "", code, killed });

test("git returns stdout, and undefined when the command fails, is killed or throws", async () => {
  assert.equal(await git(reply("out"), "/r", ["status"]), "out");
  assert.equal(await git(reply("out", 1), "/r", ["status"]), undefined);
  assert.equal(await git(reply("out", 0, true), "/r", ["status"]), undefined);
  assert.equal(await git((async () => { throw new Error("no git"); }) as any, "/r", ["status"]), undefined);
});

test("gitHead only accepts a commit hash", async () => {
  const hash = "a".repeat(40);
  assert.equal(await gitHead(reply(`${hash}\n`), "/r"), hash);
  assert.equal(await gitHead(reply("fatal"), "/r"), undefined);
  assert.equal(await gitHead(reply(hash, 128), "/r"), undefined);
});

test("diffBase keeps a baseCommit that resolves, else the commit before the task started, else the empty tree; HEAD only without a task", async () => {
  const hash = "b".repeat(40);
  const startedAt = "2026-10-01T00:00:00.000Z";
  const calls: string[][] = [];
  const logged: any = async (_cmd: string, args: string[]) => (calls.push(args), { stdout: hash, stderr: "", code: 0, killed: false });
  assert.equal(await diffBase(reply(hash), "/r", { baseCommit: hash }), hash);
  assert.equal(await diffBase(logged, "/r", { baseCommit: "x; rm", startedAt }), hash);
  assert.deepEqual(calls, [["rev-list", "-1", `--before=${startedAt}`, "HEAD"]]);
  assert.equal(await diffBase(reply("", 1), "/r", { baseCommit: hash, startedAt }), EMPTY_TREE);
  assert.equal(await diffBase(reply(hash), "/r", { baseCommit: "x; rm", startedAt: "now" }), EMPTY_TREE);
  assert.equal(await diffBase(reply(hash), "/r", {}), EMPTY_TREE);
  assert.equal(await diffBase(reply(hash), "/r", undefined), "HEAD");
});

test("file listings are NUL-separated, keep odd names and drop .pi/ state", async () => {
  const out = "src/a b.ts\0.pi/task.json\0.pi/skills/x/SKILL.md\0café\nline.ts\0";
  assert.deepEqual(await untrackedFiles(reply(out), "/r"), ["src/a b.ts", "café\nline.ts"]);
  assert.deepEqual(await changedFiles(reply(out), "/r", "HEAD"), ["src/a b.ts", "café\nline.ts"]);
  assert.deepEqual(await changedFiles(reply("x", 1), "/r", "HEAD"), []);
});
