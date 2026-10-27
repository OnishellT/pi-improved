export type Exec = (command: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface StepResult {
  step: string;
  ok: boolean;
  output: string;
}

export const DEFAULT_MAX_REPORT = 4000;
/** A manifest `maxReport` counts only when it is a number of at least 200; anything else keeps the default. */
export const validCap = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 200 ? Math.floor(n) : undefined);
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

/** Runs verify steps in order and stops at the first failure. Each step keeps the last `maxReport` characters of its output. */
export async function runVerify(steps: string[], exec: Exec, cwd: string, timeout = 10 * 60_000, maxReport = DEFAULT_MAX_REPORT) {
  const results: StepResult[] = [];
  for (const step of steps) {
    const { stdout, stderr, code, killed } = await exec("bash", ["-lc", step], { cwd, timeout });
    const ok = code === 0 && !killed;
    results.push({ step, ok, output: tail(`${stdout}\n${stderr}`.trim(), maxReport) });
    if (!ok) break;
  }
  return { ok: results.length === steps.length && results.every((r) => r.ok), results };
}

/** A failing agentlint gate needs a fix or a recorded decision, not a smarter model. */
export const isPolicyFailure = ({ results }: Awaited<ReturnType<typeof runVerify>>) =>
  results.some((r) => !r.ok && /\bagentlint\b|gate closed|unresolved findings/i.test(`${r.step}\n${r.output}`));

export function formatVerify({ ok, results }: Awaited<ReturnType<typeof runVerify>>) {
  const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.step}`);
  const failed = results.find((r) => !r.ok);
  return [ok ? "verify passed" : "verify FAILED", ...lines, ...(failed ? ["", failed.output] : [])].join("\n");
}
