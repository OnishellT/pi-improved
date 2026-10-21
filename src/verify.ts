export type Exec = (command: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface StepResult {
  step: string;
  ok: boolean;
  output: string;
}

const TAIL = 4000;
const tail = (text: string) => (text.length > TAIL ? `…${text.slice(-TAIL)}` : text);

/** Runs verify steps in order and stops at the first failure. */
export async function runVerify(steps: string[], exec: Exec, cwd: string, timeout = 10 * 60_000) {
  const results: StepResult[] = [];
  for (const step of steps) {
    const { stdout, stderr, code, killed } = await exec("bash", ["-lc", step], { cwd, timeout });
    const ok = code === 0 && !killed;
    results.push({ step, ok, output: tail(`${stdout}\n${stderr}`.trim()) });
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
