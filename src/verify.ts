import type { Exec } from "./git.ts";
import { agentlintCheck } from "./discover.ts";
import type { Manifest } from "./manifest.ts";
import { isNixFailure } from "./nix.ts";

export interface StepResult {
  step: string;
  ok: boolean;
  output: string;
  /** The step did not run: Nix, which runs every command, is missing or could not build its package. The output says which. */
  infra?: boolean;
  /** The timeout or a signal stopped it, so its output is partial. */
  killed?: boolean;
}

export const DEFAULT_MAX_REPORT = 4000;
export const VERIFY_TIMEOUT = 10 * 60_000;
/** A manifest `maxReport` counts only when it is a number of at least 200; anything else keeps the default. */
export const validCap = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 200 ? Math.floor(n) : undefined);
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

/** Runs verify steps in order and stops at the first failure. Each step keeps the last `maxReport` characters of its output. */
export async function runVerify(steps: string[], exec: Exec, cwd: string, timeout = VERIFY_TIMEOUT, maxReport = DEFAULT_MAX_REPORT, signal?: AbortSignal) {
  const results: StepResult[] = [];
  for (const step of steps) {
    // Login shell on purpose: it loads PATH from nvm/asdf and the like, which a plain `bash -c` would miss.
    const { stdout, stderr, code, killed } = await exec("bash", ["-lc", step], { cwd, timeout, ...(signal && { signal }) });
    const ok = code === 0 && !killed;
    results.push({ step, ok, output: tail(`${stdout}\n${stderr}`.trim(), maxReport), ...(killed && { killed: true }), ...(isNixFailure({ code, stderr }) && { infra: true }) });
    if (!ok) break;
  }
  return { ok: results.length === steps.length && results.every((r) => r.ok), results };
}

/** The Nix message when verify could not run because Nix is missing or failed to build: the user must act, and no change to the code helps. */
export const infraFailure = ({ results }: Awaited<ReturnType<typeof runVerify>>) => results.find((r) => r.infra)?.output;

/** One `agentlint check` command and its plain arguments: no shell operators, quotes, redirections or substitutions. */
const BARE_AGENTLINT = /^\s*(?:\S*\/)?agentlint\s+check(?:\s+[^\s;&|<>`$()'"\\]+)*\s*$/;
/** Which verify steps are the agentlint gate: the step setup recorded (`agentlintStep`; a setup from before the record added `<agentlint> check --all`), or a bare `agentlint check …`. Nothing else is parsed. Setup always adds its own step, so a package script or compound command that also runs agentlint is an ordinary step. */
export const agentlintStepOf = (manifest: Pick<Manifest, "agentlint" | "agentlintStep"> = {}) => {
  const recorded = manifest.agentlintStep ?? (manifest.agentlint ? agentlintCheck(manifest.agentlint) : undefined);
  return (step: string) => step === recorded || BARE_AGENTLINT.test(step);
};
/** A failing agentlint gate needs a fix or a recorded decision, not a smarter model. It is recognised by its command, never by words in the output. */
/** The verify steps in run order: the recorded agentlint step first, so its findings reach the per-finding approval before another step that also runs agentlint stops the run. */
export const verifySteps = ({ verify, agentlintStep }: Pick<Manifest, "verify" | "agentlintStep">) =>
  agentlintStep && verify.includes(agentlintStep) ? [agentlintStep, ...verify.filter((step) => step !== agentlintStep)] : verify;
export const isPolicyStep = (r: StepResult, isAgentlint = agentlintStepOf()) => !r.ok && isAgentlint(r.step);
export const isPolicyFailure = ({ results }: Awaited<ReturnType<typeof runVerify>>, isAgentlint?: (step: string) => boolean) => results.some((r) => isPolicyStep(r, isAgentlint));

export function formatVerify({ ok, results }: Awaited<ReturnType<typeof runVerify>>) {
  const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.step}`);
  return [ok ? "verify passed" : "verify FAILED", ...lines, ...results.filter((r) => !r.ok).flatMap((r) => ["", r.output])].join("\n");
}

type VerifyRun = Awaited<ReturnType<typeof runVerify>>;

const FAILURE_LINE = /fail|error|✗|panick|assert/i;

/** The failing step and every line of its output with volatile values (times, durations, addresses) and whitespace normalized, sorted. Repeats stay: a line seen twice counts twice. */
export interface Signature {
  step: string;
  lines: string[];
}

function outputLines(output: string): string[] {
  const lines = output.split("\n");
  if (output.startsWith("…")) lines.shift();
  return lines.map((l) => l.trim()).filter(Boolean);
}

/** What changes on every run of the same failure: timestamps, memory addresses (0x and 8 or more digits), durations. Line numbers and counts stay, so a shifted or different failure reads as new. */
const VOLATILE: [RegExp, string][] = [
  [/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, "<time>"],
  [/\b\d\d:\d\d:\d\d(?:[.,]\d+)?/g, "<time>"],
  [/\b0x[0-9a-fA-F]{8,}\b/g, "<hex>"],
  [/\b\d+(?:\.\d+)?(?:ms|s|m)\b/g, "<duration>"],
  [/\b(duration(?:_ms)?\W{0,3})\d+(?:\.\d+)?/gi, "$1<duration>"],
];
const normalize = (line: string) => VOLATILE.reduce((l, [re, to]) => l.replace(re, to), line).replace(/\s+/g, " ");

/** The lines of a step's output that look like errors, as printed. A cut-off first line (the report keeps only a tail) is dropped. */
export const failureLines = (output: string) => outputLines(output).filter((l) => FAILURE_LINE.test(l));

/** Undefined when the step passed, printed nothing, or its output is partial (killed, or cut to the report size): a partial output never matches another. */
export function stepSignature(r: StepResult): Signature | undefined {
  if (r.ok || r.killed || r.output.startsWith("…")) return undefined;
  const lines = outputLines(r.output).map(normalize).sort();
  return lines.length ? { step: r.step, lines } : undefined;
}

/** The signature of the step that stopped the run: the last failing one. */
export const failureSignature = ({ results }: VerifyRun) => stepSignature(results.findLast((r) => !r.ok) ?? { step: "", ok: true, output: "" });

const counts = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());

/** The same step failed with exactly the same lines, as many times each. */
export function sameFailure(a?: Signature, b?: Signature) {
  if (!a || !b || a.step !== b.step || a.lines.length !== b.lines.length) return false;
  const had = counts(b.lines);
  return [...counts(a.lines)].every(([line, n]) => n === had.get(line));
}
