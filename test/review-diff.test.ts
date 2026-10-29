import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./helpers.ts"; // clears the GIT_* variables a hook would set
import {
  changedLines,
  commentableLines,
  gitDiffCommand,
  splitDiffByFile,
  wholeFileChanges,
} from "../scripts/review/diff.ts";

const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 one
-two
+two changed
+two and a half
 three
@@ -20,2 +21,3 @@ function x() {
 twenty
+added
 end
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-gone too
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+first
+second
\\ No newline at end of file
`;

test("maps hunk lines of the new file, counting added and context lines only", () => {
  const lines = commentableLines(diff);
  assert.deepEqual([...(lines.get("src/a.ts") ?? [])], [1, 2, 3, 4, 21, 22, 23]);
  assert.deepEqual([...(lines.get("new.ts") ?? [])], [1, 2]);
});

test("a deleted file has no commentable lines", () => {
  assert.equal(commentableLines(diff).has("old.ts"), false);
});

test("lines between hunks are not commentable", () => {
  assert.equal(commentableLines(diff).get("src/a.ts")?.has(10), false);
});

test("splits a diff into one chunk per file by post-image path", () => {
  assert.deepEqual(splitDiffByFile(diff).map((file) => file.path), ["src/a.ts", "old.ts", "new.ts"]);
});

test("changedLines leaves out unchanged hunk context", () => {
  const lines = changedLines(diff);
  assert.deepEqual([...(lines.get("src/a.ts") ?? [])].sort((a, b) => a - b), [1, 2, 3, 22]);
  assert.deepEqual([...(lines.get("new.ts") ?? [])], [1, 2]);
  assert.equal(lines.has("old.ts"), false);
});

test("changedLines keeps the lines around a deletion-only change", () => {
  const deletion = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -3,5 +3,4 @@
 three
 four
-check()
 six
 seven
`;
  assert.deepEqual([...(changedLines(deletion).get("src/b.ts") ?? [])].sort(), [4, 5]);
});

test("splitDiffByFile decodes quoted paths, keeping characters outside the BMP intact", () => {
  const quoted = `diff --git "a/\u{1F600}\\"x\\303\\251.ts" "b/\u{1F600}\\"x\\303\\251.ts"
--- "a/\u{1F600}\\"x\\303\\251.ts"
+++ "b/\u{1F600}\\"x\\303\\251.ts"
@@ -1 +1 @@
-a
+b
diff --git "a/tab\\there.bin" "b/tab\\there.bin"
deleted file mode 100644
Binary files "a/tab\\there.bin" and /dev/null differ
`;
  assert.deepEqual(splitDiffByFile(quoted).map((file) => file.path), ['\u{1F600}"xé.ts', "tab\there.bin"]);
});

test("splitDiffByFile reads an unquoted binary path that contains \" b/\"", () => {
  const binary = `diff --git a/foo b/bar b/foo b/bar
index 111..222 100644
Binary files a/foo b/bar and b/foo b/bar differ
diff --git a/x b/y b/z
similarity index 100%
rename from x b/y
rename to z
`;
  assert.deepEqual(splitDiffByFile(binary).map((file) => file.path), ["foo b/bar", "z"]);
  assert.deepEqual([...wholeFileChanges(binary)], ["foo b/bar"]);
});

test("gitDiffCommand output parses the same whatever the user's git config", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-diff-"));
  try {
    const env = { ...process.env, GIT_DIFF_OPTS: "--unified=0" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git("init", "-q");
    for (const [key, value] of [
      ["user.name", "t"],
      ["user.email", "t@t"],
      ["diff.context", "0"],
      ["diff.noprefix", "true"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.renames", "false"],
      ["core.quotePath", "true"],
    ]) {
      git("config", key, value);
    }
    const text = 'f "q".ts';
    const image = "café\\x.png";
    const lines = (skip: number) =>
      Array.from({ length: 10 }, (_, i) => (i === 3 ? "" : `line ${i + 1}`)).filter((_, i) => i + 1 !== skip);
    writeFileSync(join(dir, text), `${lines(0).join("\n")}\n`);
    writeFileSync(join(dir, image), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "old.ts"), `${lines(0).join("\n")}\n`);
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(join(dir, text), `${lines(6).join("\n")}\n`);
    writeFileSync(join(dir, image), Buffer.from([0, 3, 4]));
    git("mv", "old.ts", "moved.ts");
    git("commit", "-qam", "two");
    const [cmd = "", ...args] = gitDiffCommand("HEAD~1..HEAD");
    const delta = execFileSync(cmd, args, { cwd: dir, env, encoding: "utf8" });
    assert.deepEqual([...(changedLines(delta).get(text) ?? [])].sort(), [5, 6]);
    assert.deepEqual([...wholeFileChanges(delta)], [image]);
    assert.equal(changedLines(delta).get("moved.ts")?.size ?? 0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
