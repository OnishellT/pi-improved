// Pure helpers over unified diffs (`gh pr diff` output).

export interface FileDiff {
  path: string;
  text: string;
}

// Splits a multi-file diff into one chunk per file, keyed by the post-image path.
// Deleted files (+++ /dev/null) fall back to the pre-image path.
export function splitDiffByFile(diff: string): FileDiff[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  return chunks.map((text) => {
    const added = /^\+\+\+ (?:b\/)?(.+?)\t?$/m.exec(text)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
    const path = added && added !== "/dev/null" ? added : (header?.[2] ?? header?.[1] ?? "");
    return { path, text };
  });
}

// Lines of the new file that exist in a hunk (added or context). GitHub accepts inline
// comments with side RIGHT only on these lines.
export function commentableLines(diff: string): Map<string, Set<number>> {
  return newFileLines(diff, true);
}

// Lines of the new file that the diff added, without unchanged hunk context.
export function addedLines(diff: string): Map<string, Set<number>> {
  return newFileLines(diff, false);
}

function newFileLines(diff: string, withContext: boolean): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const file of splitDiffByFile(diff)) {
    if (/^\+\+\+ \/dev\/null/m.test(file.text)) continue;
    const lines = result.get(file.path) ?? new Set<number>();
    result.set(file.path, lines);
    let newLine = 0;
    let inHunk = false;
    for (const row of file.text.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
      } else if (!inHunk || row.startsWith("\\") || row.startsWith("diff --git ")) {
        if (row.startsWith("diff --git ")) inHunk = false;
      } else if (row.startsWith("-")) {
        continue;
      } else if (row.startsWith("+") || row.startsWith(" ")) {
        if (withContext || row.startsWith("+")) lines.add(newLine);
        newLine += 1;
      }
    }
  }
  return result;
}
