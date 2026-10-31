import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { changedFiles, diffBase, EMPTY_TREE, fileChanges, git, gitHead, untrackedFiles } from "../src/git.ts";

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

test("fileChanges never follows a symlink or reads a huge new file, and is undefined when git fails", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-changes-"));
  // A read through the link would block on the FIFO for good.
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  await fs.symlink("pipe", path.join(root, "link"));
  await fs.writeFile(path.join(root, "big.txt"), "x".repeat((1 << 20) + 1));
  await fs.writeFile(path.join(root, "small.txt"), "a\nb");
  const exec = (failing?: string): any => async (_cmd: string, args: string[]) =>
    args.includes(failing ?? "none") ? { stdout: "", stderr: "fatal", code: 128, killed: false } : { stdout: args[0] === "ls-files" ? "link\0big.txt\0small.txt\0" : "", stderr: "", code: 0, killed: false };
  assert.deepEqual(await fileChanges(exec(), root, "HEAD"), [
    { file: "big.txt", status: "added" },
    { file: "link", status: "added" },
    { file: "small.txt", status: "added", added: 2, removed: 0 },
  ]);
  for (const failing of ["--name-status", "--numstat", "ls-files"]) assert.equal(await fileChanges(exec(failing), root, "HEAD"), undefined);
  await fs.rm(root, { recursive: true, force: true });
});
