// Pure helpers over unified diffs (`git diff` output, see gitDiffCommand).

export interface FileDiff {
  path: string;
  text: string;
}

// The git command whose output these helpers parse. The pinned options keep user config
// (diff.context, diff.renames, diff.suppressBlankEmpty, prefixes, external drivers) and GIT_DIFF_OPTS,
// which overrides --unified, from changing that format.
export function gitDiffCommand(range: string): string[] {
  return [
    "env",
    "-u",
    "GIT_DIFF_OPTS",
    "git",
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--unified=3",
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    range,
  ];
}

const quoted = String.raw`"(?:[^"\\]|\\.)*"`;
const cEscapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

// Git C-quotes a path with unusual characters ("a/caf\303\251.png"); this decodes it.
// Works on UTF-8 bytes: an escape is ASCII, and no byte of a multi-byte character is "\".
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const raw = Buffer.from(path.slice(1, -1));
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i] ?? 0;
    const next = raw[i + 1] ?? 0;
    if (byte !== 0x5c) {
      bytes.push(byte);
    } else if (next >= 0x30 && next <= 0x37) {
      bytes.push(Number.parseInt(raw.subarray(i + 1, i + 4).toString(), 8));
      i += 3;
    } else {
      bytes.push(cEscapes[String.fromCharCode(next)] ?? next);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Splits a multi-file diff into one chunk per file, keyed by the post-image path.
// Deleted files (+++ /dev/null) fall back to the pre-image path.
export function splitDiffByFile(diff: string): FileDiff[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  const addedLine = new RegExp(String.raw`^\+\+\+ (${quoted}|.+?)\t?$`, "m");
  const headerLine = new RegExp(String.raw`^diff --git (${quoted}|a/.+?) (${quoted}|b/.+)$`, "m");
  return chunks.map((text) => {
    const added = unquote(addedLine.exec(text)?.[1] ?? "").replace(/^b\//, "");
    const path = added && added !== "/dev/null" ? added : headerPath(text, headerLine);
    return { path, text };
  });
}

// The post-image path from the header, for entries without a +++ line (binary, mode-only,
// rename-only). Without a rename both sides name one path, "a/P b/P", so the exact middle
// splits it even when P contains " b/"; otherwise "rename to" or the first " b/" decides.
function headerPath(text: string, headerLine: RegExp): string {
  const rest = /^diff --git (.+)$/m.exec(text)?.[1] ?? "";
  const middle = (rest.length - 1) / 2;
  const [pre, post] = [rest.slice(0, middle), rest.slice(middle + 1)];
  if (rest[middle] === " " && pre.startsWith("a/") && post === `b/${pre.slice(2)}`) {
    return pre.slice(2);
  }
  const renamed = /^rename to (.+)$/m.exec(text)?.[1];
  if (renamed !== undefined) return unquote(renamed);
  const header = headerLine.exec(text);
  return unquote(header?.[2] ?? "").replace(/^b\//, "") || unquote(header?.[1] ?? "").replace(/^a\//, "");
}

// Lines of the new file that exist in a hunk (added or context). GitHub accepts inline
// comments with side RIGHT only on these lines.
export function commentableLines(diff: string): Map<string, Set<number>> {
  return newFileLines(diff, true);
}

// Files the diff changed as a whole: deleted, emptied or binary. They have no changed lines
// to match, so a finding on any line counts. Rename-only and mode-only entries are not here.
const wholeFileChange = /^(?:deleted file mode |\+\+\+ \/dev\/null|@@ -\S+ \+0,0 @@|Binary files .* differ$|GIT binary patch$)/m;

export function wholeFileChanges(diff: string): Set<string> {
  return new Set(
    splitDiffByFile(diff)
      .filter((file) => wholeFileChange.test(file.text))
      .map((file) => file.path),
  );
}

// Lines of the new file the diff touched: added lines, plus the surviving lines on both
// sides of a deletion. Unchanged hunk context further away is left out.
export function changedLines(diff: string): Map<string, Set<number>> {
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
        if (!withContext) {
          if (newLine > 0) lines.add(newLine);
          if (newLine > 1) lines.add(newLine - 1);
        }
      } else if (row.startsWith("+") || row.startsWith(" ")) {
        if (withContext || row.startsWith("+")) lines.add(newLine);
        newLine += 1;
      }
    }
  }
  return result;
}
