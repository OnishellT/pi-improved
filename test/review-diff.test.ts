import { test } from "node:test";
import assert from "node:assert/strict";
import { addedLines, commentableLines, splitDiffByFile } from "../scripts/review/diff.ts";

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

test("addedLines leaves out unchanged hunk context", () => {
  const lines = addedLines(diff);
  assert.deepEqual([...(lines.get("src/a.ts") ?? [])], [2, 3, 22]);
  assert.deepEqual([...(lines.get("new.ts") ?? [])], [1, 2]);
  assert.equal(lines.has("old.ts"), false);
});
