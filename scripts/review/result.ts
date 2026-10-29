// The reviewer's structured result: schema, extraction, mapping onto the diff, and the
// text posted to the pull request.
import { z } from "zod";

const Severity = z.enum(["critical", "major", "minor", "nit"]);
export type Severity = z.infer<typeof Severity>;

const Finding = z.strictObject({
  path: z.string(),
  line: z.int(),
  severity: Severity,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

const Resolution = z.strictObject({
  threadId: z.string(),
  verdict: z.enum(["fixed", "not_fixed"]),
  note: z.string(),
});
export type Resolution = z.infer<typeof Resolution>;

const Review = z.strictObject({
  confidence: z.int().min(1).max(5),
  summary: z.string(),
  findings: z.array(Finding),
  resolved: z.array(Resolution).optional(),
});
export type Review = z.infer<typeof Review>;

export type Decoded = { ok: true; review: Review } | { ok: false; error: string };

// The result is the last fenced block of the answer (```json preferred).
export function extractJson(answer: string): string | undefined {
  const blocks = [...answer.matchAll(/^```(\w*)[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gm)];
  const json = blocks.filter((block) => block[1] === "json");
  const pick = (json.length > 0 ? json : blocks).at(-1);
  return pick?.[2]?.trim();
}

// Words that would name the tooling in posted text (the product's own name, pi, is allowed).
const forbiddenWord = /\b(claude|anthropic|openai|gpt|chatgpt)\b/i;
const forbiddenPhrase = /generated (?:by|with)|as an? (?:language model|assistant)/i;

// Code spans and file names (`CLAUDE.md`, `scripts/review/pi-stream.ts`) are not prose.
const fileLike = /`[^`]*`|[\w.-]*\/[\w./-]*|[\w-]+\.(?:ts|js|md|json|mjs|sh|yml|yaml|css)\b/g;

export function findNeutralityViolation(text: string): string | undefined {
  const prose = text.replace(fileLike, " ");
  return forbiddenWord.exec(prose)?.[0] ?? forbiddenPhrase.exec(prose)?.[0];
}

// The reviewer reads untrusted text and can read local files, so nothing that contains one of
// the owner's secrets is ever posted.
export function findSecretLeak(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length >= 8 && text.includes(secret));
}

export function decodeReview(answer: string): Decoded {
  const json = extractJson(answer);
  if (json === undefined) return { ok: false, error: "No fenced JSON block found in the answer." };
  let value: unknown;
  try {
    // HTML comments are dropped so that a marker echoed by the model is never mistaken for the real one.
    // A null property is read as an absent one: the model often writes `"suggestion": null`.
    value = JSON.parse(json.replace(/<!--[\s\S]*?-->/g, ""), (_key, field: unknown) =>
      field === null ? undefined : field,
    );
  } catch (cause) {
    return { ok: false, error: `The JSON block does not parse: ${String(cause)}` };
  }
  const parsed = Review.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: `The JSON does not match the schema: ${parsed.error.message}` };
  }
  const review = parsed.data;
  // Prose only: paths and suggested code legitimately contain names such as CLAUDE.md.
  const text = [
    review.summary,
    ...review.findings.flatMap((finding) => [finding.title, finding.body]),
    ...(review.resolved ?? []).map((resolution) => resolution.note),
  ].join("\n");
  const word = findNeutralityViolation(text);
  if (word !== undefined) {
    return {
      ok: false,
      error: `The text mentions "${word}". Posted text must not name any tool, model, vendor or author; rewrite it neutrally.`,
    };
  }
  return { ok: true, review };
}

// Open threads the reviewer gave no verdict for (or gave more than one).
export function missingVerdicts(review: Review, openThreadIds: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const verdict of review.resolved ?? []) {
    counts.set(verdict.threadId, (counts.get(verdict.threadId) ?? 0) + 1);
  }
  return openThreadIds.filter((id) => counts.get(id) !== 1);
}

export function actionableCount(review: Review): number {
  return review.findings.filter((finding) => finding.severity !== "nit").length;
}

export interface Marker {
  sha: string;
  confidence: number;
  actionable: number;
}

export function buildMarker(marker: Marker): string {
  return `<!-- local-review sha=${marker.sha} confidence=${marker.confidence} actionable=${marker.actionable} -->`;
}

export function parseMarker(body: string): Marker | undefined {
  // The script appends the real marker last; model text never contains one (comments are stripped).
  const matches = [
    ...body.matchAll(
      /<!-- local-review sha=([0-9a-f]{7,40}) confidence=([1-5]) actionable=(\d+) -->/g,
    ),
  ];
  const match = matches.at(-1);
  if (!match) return undefined;
  return { sha: match[1] ?? "", confidence: Number(match[2]), actionable: Number(match[3]) };
}

export interface SplitFindings {
  inline: Finding[];
  outside: Finding[];
}

// Only lines inside the diff's hunks can carry an inline comment.
export function splitFindings(
  findings: readonly Finding[],
  commentable: Map<string, Set<number>>,
): SplitFindings {
  const inline: Finding[] = [];
  const outside: Finding[] = [];
  for (const finding of findings) {
    (commentable.get(finding.path)?.has(finding.line) ? inline : outside).push(finding);
  }
  return { inline, outside };
}

export function inlineCommentBody(finding: Finding): string {
  const suggestion =
    finding.suggestion === undefined ? "" : `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  return `**${finding.severity}: ${finding.title}**\n\n${finding.body}${suggestion}`;
}

const confidenceMeaning: Record<number, string> = {
  1: "must not merge",
  2: "serious problems",
  3: "issues to fix before merging",
  4: "only nits left",
  5: "safe to merge",
};

export interface BodyInput {
  review: Review;
  sha: string;
  outside: readonly Finding[];
  threadNotes: readonly string[];
  notFixed?: number;
}

export function renderBody({ review, sha, outside, threadNotes, notFixed = 0 }: BodyInput): string {
  const counts = (severity: Severity) =>
    review.findings.filter((finding) => finding.severity === severity).length;
  const parts = [
    "## Local review",
    `**Confidence: ${review.confidence}/5** (${confidenceMeaning[review.confidence] ?? ""})`,
    [
      "| Severity | Findings |",
      "| --- | --- |",
      ...(["critical", "major", "minor", "nit"] as const).map(
        (severity) => `| ${severity} | ${counts(severity)} |`,
      ),
    ].join("\n"),
    review.summary.trim(),
  ];
  if (outside.length > 0) {
    parts.push(
      [
        "### Outside the diff",
        ...outside.map(
          (finding) =>
            `- **${finding.severity}: ${finding.title}** (\`${finding.path}:${finding.line}\`) ${finding.body}`,
        ),
      ].join("\n"),
    );
  }
  if (threadNotes.length > 0) {
    parts.push(["### Earlier threads", ...threadNotes].join("\n"));
  }
  parts.push(
    buildMarker({
      sha,
      confidence: review.confidence,
      actionable: actionableCount(review) + notFixed,
    }),
  );
  return parts.join("\n\n");
}
