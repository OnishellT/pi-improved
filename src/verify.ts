import type { Exec } from "./git.ts";
import { isNixMissing } from "./nix.ts";

export interface StepResult {
  step: string;
  ok: boolean;
  output: string;
  /** The step did not run: Nix, which runs every command, is not installed. */
  /** Nix's own message when it is missing or could not build, so the user sees which. */
  nixMissing?: string;
  /** The timeout or a signal stopped it, so its output is partial. */
  killed?: boolean;
}

export const DEFAULT_MAX_REPORT = 4000;
export const VERIFY_TIMEOUT = 10 * 60_000;
/** A manifest `maxReport` counts only when it is a number of at least 200; anything else keeps the default. */
export const validCap = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 200 ? Math.floor(n) : undefined);
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

/** Runs verify steps in order and stops at the first failure, unless `carryOn` says that failure does not count. Each step keeps the last `maxReport` characters of its output. */
export async function runVerify(steps: string[], exec: Exec, cwd: string, timeout = VERIFY_TIMEOUT, maxReport = DEFAULT_MAX_REPORT, signal?: AbortSignal, carryOn?: (failed: StepResult) => boolean) {
  const results: StepResult[] = [];
  for (const step of steps) {
    // Login shell on purpose: it loads PATH from nvm/asdf and the like, which a plain `bash -c` would miss.
    const { stdout, stderr, code, killed } = await exec("bash", ["-lc", step], { cwd, timeout, ...(signal && { signal }) });
    const ok = code === 0 && !killed;
    results.push({ step, ok, output: tail(`${stdout}\n${stderr}`.trim(), maxReport), ...(killed && { killed: true }), ...(isNixMissing({ code, stderr }) && { nixMissing: stderr }) });
    if (!ok && !carryOn?.(results[results.length - 1])) break;
  }
  return { ok: results.length === steps.length && results.every((r) => r.ok), results };
}

/** Verify could not run because Nix is missing: the user must install it, and no change to the code helps. */
export const isNixMissingFailure = ({ results }: Awaited<ReturnType<typeof runVerify>>) => results.find((r) => r.nixMissing)?.nixMissing;

/** A failing agentlint gate needs a fix or a recorded decision, not a smarter model. */
export const isPolicyStep = (r: StepResult) => !r.ok && /\bagentlint\b|gate closed|unresolved findings/i.test(`${r.step}\n${r.output}`);
export const isPolicyFailure = ({ results }: Awaited<ReturnType<typeof runVerify>>) => results.some(isPolicyStep);

export function formatVerify({ ok, results }: Awaited<ReturnType<typeof runVerify>>) {
  const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.step}`);
  // Every failed step's output: an old failure the run carried on past keeps its diagnostics next to the new one.
  const failed = results.filter((r) => !r.ok);
  return [ok ? "verify passed" : "verify FAILED", ...lines, ...failed.flatMap((r) => ["", ...(failed.length > 1 ? [`✗ ${r.step}:`] : []), r.output])].join("\n");
}

type VerifyRun = Awaited<ReturnType<typeof runVerify>>;

const FAILURE_LINE = /fail|error|✗|panick|assert/i;

/** The failing step and its failure lines with numbers and whitespace normalized, sorted and without repeats. */
export interface Signature {
  step: string;
  lines: string[];
}

/** The lines of a step's output that look like errors, as printed. A cut-off first line (the report keeps only a tail) is dropped. */
export function failureLines(output: string): string[] {
  const lines = output.split("\n");
  if (output.startsWith("…")) lines.shift();
  return lines.map((l) => l.trim()).filter((l) => FAILURE_LINE.test(l));
}

/** What changes on every run of the same failure: timestamps, memory addresses (0x and 8 or more digits), durations. Line numbers and counts stay, so a shifted or different failure reads as new. */
const VOLATILE: [RegExp, string][] = [
  [/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, "<time>"],
  [/\b\d\d:\d\d:\d\d(?:[.,]\d+)?/g, "<time>"],
  [/\b0x[0-9a-fA-F]{8,}\b/g, "<hex>"],
  [/\b\d+(?:\.\d+)?(?:ms|s|m)\b/g, "<duration>"],
];
const normalize = (line: string) => VOLATILE.reduce((l, [re, to]) => l.replace(re, to), line).replace(/\s+/g, " ");

/** Undefined when the step passed, was killed (its output is partial, so it never matches a baseline) or printed no error line. */
export function stepSignature(r: StepResult): Signature | undefined {
  if (r.ok || r.killed) return undefined;
  const lines = [...new Set(failureLines(r.output).map(normalize))].sort();
  return lines.length ? { step: r.step, lines } : undefined;
}

/** The signature of the step that stopped the run: the last failing one. */
export const failureSignature = ({ results }: VerifyRun) => stepSignature(results.findLast((r) => !r.ok) ?? { step: "", ok: true, output: "" });

/** The same step failed with exactly the same lines. */
export const sameFailure = (a?: Signature, b?: Signature) => !!a && !!b && a.step === b.step && a.lines.length === b.lines.length && a.lines.every((l) => b.lines.includes(l));

/** Every failure line of `now` was already failing in `before`: nothing new broke. */
export const predates = (now?: Signature, before?: Signature) => !!now && !!before && now.step === before.step && now.lines.every((l) => before.lines.includes(l));

/** One failing step whose lines were all failing at the baseline already. */
const stepPredates = (r: StepResult, before: Signature[] | undefined) => predates(stepSignature(r), Array.isArray(before) ? before.find((f) => f.step === r.step) : undefined);

/** Something failed, and every failing step failed only with lines it already had at the baseline. A step the baseline never ran or never saw fail counts as new. */
export const predatesBaseline = ({ results }: VerifyRun, before: Signature[] | undefined) => {
  const failed = results.filter((r) => !r.ok);
  return failed.length > 0 && failed.every((r) => !isPolicyStep(r) && stepPredates(r, before));
};

/** The failure lines of every failing step, as printed. */
/** The error lines of every failed step; a step whose output has none (a bare diff, say) is named by its command. */
export const failedLines = ({ results }: VerifyRun) =>
  results.filter((r) => !r.ok).flatMap((r) => {
    const lines = failureLines(r.output);
    return lines.length ? lines : [r.step];
  });

/** The carryOn for `runVerify`: a failing step that predates the baseline does not stop the run, so later steps still run. */
export const carryOnWhenPredated = (before: Signature[] | undefined) => (r: StepResult) => !isPolicyStep(r) && stepPredates(r, before);

export interface Baseline {
  ok: boolean;
  /** Seconds the first verify command took. */
  seconds: number;
  /** Each step that failed, with its failure lines. */
  failing?: Signature[];
}

/** Every verify command run once before implementing, none stopping the others. Undefined when it cannot say (no steps, Nix missing, aborted). */
export async function runBaseline(steps: string[], exec: Exec, cwd: string, maxReport?: unknown, signal?: AbortSignal): Promise<Baseline | undefined> {
  if (!steps.length) return undefined;
  const results: StepResult[] = [];
  let seconds = 0;
  for (const step of steps) {
    const t0 = Date.now();
    const run = await runVerify([step], exec, cwd, VERIFY_TIMEOUT, validCap(maxReport), signal);
    if (isNixMissingFailure(run) || signal?.aborted) return undefined;
    if (!results.length) seconds = (Date.now() - t0) / 1000;
    results.push(...run.results);
  }
  const failing = results.map(stepSignature).filter((x): x is Signature => !!x);
  return results.every((r) => r.ok) ? { ok: true, seconds } : { ok: false, seconds, failing };
}
