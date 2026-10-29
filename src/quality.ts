import * as fs from "node:fs/promises";
import * as path from "node:path";
import { git, untrackedFiles, type Exec } from "./git.ts";
import type { Task } from "./task-state.ts";

// Code-quality rules that a diff can show. Each one is a fact collector (the diff and the task) and a pure decision over those facts, so every combination can be tested.
// Path and line patterns only, no language parsing: they are fuzzy by design, which is why the line scans only warn the reviewer and never block.

/** A file's changed lines. A break between runs of added lines (a hunk or context boundary) is `BREAK`, so a scan never joins lines that were not neighbours. */
export interface FileDiff {
  file: string;
  added: string[];
  removed: string[];
}
export const BREAK = "\u0000";

/** Lockfiles, generated and vendored paths: their size says nothing about the change, and nobody reviews them line by line. */
const GENERATED = /(^|\/)(node_modules|vendor|dist|build|target|__pycache__)\/|(^|\/)(go\.sum|[\w.-]*lock\.(json|ya?ml)|[\w.-]*\.lockb?)$|\.min\.(js|css)$|\.map$|\.snap$|\.generated\.|\.pb\.go$|_pb2(_grpc)?\.py$/;
export const isGenerated = (file: string) => GENERATED.test(file);
const DOCS = /(^|\/)(docs?|doc)\/|\.(md|mdx|rst|txt|adoc)$/i;
export const isDocs = (file: string) => DOCS.test(file);

/** Parses `git diff -U<n>` text. Header lines are only read before a file's first hunk, so a removed `-- sql comment` is not taken for one. */
export function parseDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let inHunk = false;
  let previous = "";
  let old = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) old = line.slice(4).replace(/\t.*$/, "").replace(/^a\//, "");
    else if (!inHunk && line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/\t.*$/, "");
      out.push((cur = { file: file === "/dev/null" ? old : file.replace(/^b\//, ""), added: [], removed: [] }));
    } else if (line.startsWith("@@")) {
      inHunk = true;
      if (cur?.added.length && cur.added.at(-1) !== BREAK) cur.added.push(BREAK);
    } else if (inHunk && cur) {
      if (line.startsWith("+")) cur.added.push(line.slice(1));
      else if (line.startsWith("-")) cur.removed.push(line.slice(1));
      else if (line && previous.startsWith("+") && cur.added.at(-1) !== BREAK) cur.added.push(BREAK);
    }
    previous = line;
  }
  return out;
}

/** Added and removed lines per file since `ref`, new untracked files included as all-added; `.pi/` state and generated paths left out. Empty when git fails. */
export async function collectDiffs(exec: Exec, root: string, ref: string): Promise<FileDiff[]> {
  const text = await git(exec, root, ["-c", "core.quotepath=off", "diff", ref, "-U0", "--no-renames", "--", ".", ":(exclude).pi"]);
  const diffs = parseDiff(text ?? "");
  for (const file of await untrackedFiles(exec, root)) {
    const stat = await fs.stat(path.join(root, file)).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 200_000) continue;
    const body = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    if (body && !body.includes("\0")) diffs.push({ file, added: body.split("\n"), removed: [] });
  }
  return diffs.filter((d) => !isGenerated(d.file));
}

// --- Rule 1: a bug fix needs a test ---

const FIX_WORDS = /\b(fix(es|ed|ing)?|bug(s|fix)?|regression|crash(es|ing)?|broken|defect|hotfix)\b/i;
/** The user's words (title, ticket text) and the plan's restated intent say this task fixes something. The plan summary is left out: a feature's summary often says "fix up" something. */
export const isFixTask = (task: Pick<Task, "title" | "body" | "plan"> | undefined) => !!task && FIX_WORDS.test([task.title, task.body, task.plan?.intent].filter(Boolean).join("\n"));

// --- Rule 5: do not weaken tests ---

const ASSERTION = /\bassert\w*\b|\b(expect|should)\s*[.(]|\b(EXPECT|ASSERT)_\w+|\.(toBe\w*|toEqual|toStrictEqual|toThrow\w*|toMatch\w*|toHaveBeen\w*|toContain|toHaveLength)\(|\bt\.(Errorf?|Fatalf?)\(|\brequire\.\w+\(/;
const SKIP_MARKER = /\.(skip|only)\b|\bx(it|describe|test)\(|\bf(it|describe)\(|@pytest\.mark\.(skip\w*|xfail)|pytest\.(skip|xfail)\(|@unittest\.(skip\w*|expectedFailure)|@(Disabled|Ignore)\b|\bt\.Skip\w*\(|#\[ignore\]|\bskipIf\b|\bxfail\b|\bretry(Times)?\b|\bretries\b|@flaky|\bflaky\b|\bit\.todo\(/;

/** What a test file's diff did to its checks: assertion lines lost for good (removed minus added, so a changed expected value is not a loss) and skip/only/xfail/retry markers added. */
export function weakening(added: string[], removed: string[]): { lost: number; markers: string[] } {
  const count = (lines: string[]) => lines.filter((l) => ASSERTION.test(l)).length;
  return { lost: Math.max(0, count(removed) - count(added)), markers: added.filter((l) => SKIP_MARKER.test(l)).map((l) => l.trim().slice(0, 80)) };
}

// --- The verdict: facts -> why the change is high risk ---

export interface QualityFacts {
  /** The task is a bug fix (`isFixTask`). */
  fix: boolean;
  /** The diff changes a file that is neither a test, documentation nor generated. */
  source: boolean;
  /** The diff adds lines to a test file. */
  tests: boolean;
  /** A test file lost assertions or gained a skip/only/xfail/retry marker. */
  weakened: boolean;
  /** Changed lines, without lockfiles and generated or vendored paths, and the cap from `limits.changeCap`. */
  lines: number;
  cap: number;
  /** Reasons other collectors found (for example edits to a protected file such as the laws): each one makes the change high risk. */
  extra?: string[];
}

/** The reasons a change is high risk because of its quality facts; empty = none. Pure. */
export function qualityVerdict(f: QualityFacts): string[] {
  const reasons: string[] = [];
  if (f.fix && f.source && !f.tests) reasons.push("bug fix changes source but no test");
  if (f.weakened) reasons.push("existing tests weakened");
  if (f.lines > f.cap) reasons.push(`${f.lines} changed lines in one change (cap ${f.cap}): one purpose?`);
  reasons.push(...(f.extra ?? []));
  return reasons;
}

/** Lines the completion dialog lists for the person, one per test file that was weakened. */
export function weakenedNotes(diffs: FileDiff[], isTest: (file: string) => boolean): string[] {
  const notes: string[] = [];
  for (const d of diffs) {
    if (!isTest(d.file)) continue;
    const { lost, markers } = weakening(d.added, d.removed);
    if (lost) notes.push(`${d.file}: ${lost} assertion${lost === 1 ? "" : "s"} removed`);
    if (markers.length) notes.push(`${d.file}: ${markers.length} skip/only/xfail/retry marker${markers.length === 1 ? "" : "s"} added (${markers[0]})`);
  }
  return notes;
}

// --- Rules 2 and 11: warnings for the reviewer ---

const LOG_CALL = /^\s*(console\.\w+|print|println|puts|logging\.\w+|log(ger)?\.\w+|fmt\.Print\w*|eprintln!|System\.(out|err)\.print\w*|\w+\.printStackTrace)\b/;
const EMPTY_INLINE = [
  /\bcatch\b[^{]*\{\s*(\/\/.*|\/\*.*?\*\/)?\s*\}/,
  /\bexcept\b[^:]*:\s*(pass|\.\.\.)\s*(#.*)?$/,
  /\.catch\(\s*\(?\w*\)?\s*=>\s*(\{\s*\}|undefined|null)\s*\)/,
  /\b_\s*=\s*err\b/,
  /\blet\s+_\s*=\s*.*;/,
  /\.ok\(\);\s*$/,
  /\|\|\s*true\s*$/,
];
const HANDLER_OPEN = [/\bcatch\b[^{]*\{\s*$/, /\bexcept\b[^:]*:\s*(#.*)?$/, /^\s*rescue\b.*$/, /\bif\s+err\s*!=\s*nil\s*\{\s*$/];
const CLOSER = /^\s*(\}|end)\s*$/;
const PLACEHOLDER = /^\s*(pass|\.\.\.|continue)\s*$|\b(TODO|FIXME)\b/;

/** Added lines that swallow an error: an empty handler, one that only logs, one that only says TODO. Fuzzy across languages; the reviewer decides. */
export function swallowedErrors(added: string[]): string[] {
  const found: string[] = [];
  added.forEach((line, i) => {
    const next = added[i + 1] ?? BREAK;
    const after = added[i + 2];
    const empty = EMPTY_INLINE.some((re) => re.test(line));
    const opens = HANDLER_OPEN.some((re) => re.test(line));
    const swallowed = opens && (CLOSER.test(next) || PLACEHOLDER.test(next) || (LOG_CALL.test(next) && (after === undefined || after === BREAK || CLOSER.test(after))));
    if (empty || swallowed) found.push(line.trim().slice(0, 100));
  });
  return found;
}

const COMMENT = /^\s*(?:\/\/+|#+|--|;+|\*)\s?(.*)$/;
const CODE = /^(?:(?:if|for|while|switch|return|import|from|def|class|const|let|var|function|print|console\.\w+|await|throw|raise)\b.*[;:{(,)]|[\w.$[\]]+\s*(?:[-+*/]?=|:=)\s*[^=\s].*[;)\]]|[\w.$]+\([^)]*\)\s*;?)\s*$/;

/** Added comment lines that read as code. A shebang, a tool directive and a prose sentence do not. */
export function commentedOutCode(added: string[]): string[] {
  return added.filter((line) => {
    const body = COMMENT.exec(line)?.[1]?.trim();
    return !!body && !body.startsWith("!") && !/^(eslint|prettier|noqa|type:|pragma|@ts-|TODO|FIXME|NOTE)/i.test(body) && CODE.test(body);
  }).map((l) => l.trim().slice(0, 100));
}

const SHOWN = 5;
/** The reviewer-brief lines for a set of file diffs: nothing when the diff is clean. */
export function reviewWarnings(diffs: FileDiff[], isTest: (file: string) => boolean): string[] {
  const out: string[] = [];
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push(`${title}:`, ...items.slice(0, SHOWN).map((i) => `- ${i}`), ...(items.length > SHOWN ? [`- and ${items.length - SHOWN} more`] : []));
  };
  list("Possibly swallowed errors in added lines (empty, log-only or TODO handlers)", diffs.flatMap((d) => swallowedErrors(d.added).map((l) => `${d.file}: ${l}`)));
  list("Commented-out code in added lines (remove it instead)", diffs.filter((d) => !isDocs(d.file)).flatMap((d) => commentedOutCode(d.added).map((l) => `${d.file}: ${l}`)));
  list("Tests weakened", weakenedNotes(diffs, isTest));
  return out;
}

// --- Rule 4: commit messages ---

const COMMIT_SUBJECT = 72;
/** A commit subject: one line, no trailing period or ellipsis, at most 72 characters. A leading `[TICKET] ` prefix counts toward the 72. */
export function commitSubject(title: string, prefix = ""): string {
  const room = Math.max(1, COMMIT_SUBJECT - prefix.length);
  const first = title.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const cut = first.length > room ? first.slice(0, room).replace(/\s+\S*$/, "") || first.slice(0, room) : first;
  return `${prefix}${cut.replace(/[.…\s]+$/, "")}`.trim();
}

/** Whether /pr may commit the uncommitted work: only after verify passed, or when the project has no verify step. */
export const mayCommit = (verify: "pass" | "fail" | "none") => verify !== "fail";
