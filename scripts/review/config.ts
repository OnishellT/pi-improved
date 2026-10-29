// Reviewer configuration from the environment, and command-line parsing.
import { join } from "node:path";

export function reviewConfig(env: Record<string, string | undefined>, home: string) {
  return {
    provider: env["REVIEW_PROVIDER"] ?? "openai",
    model: env["REVIEW_MODEL"] ?? "gpt-6.1-terra",
    thinking: env["REVIEW_THINKING"] ?? "xhigh",
    timeoutMs: Number(env["REVIEW_TIMEOUT_MS"] ?? 10 * 60_000),
    idleMs: Number(env["REVIEW_IDLE_MS"] ?? 120_000),
    // Dedicated read-only pi profile, rebuilt from the repo's settings on every run.
    piDir: env["REVIEW_PI_DIR"] ?? join(home, ".pi", "reviewer-pi-improved"),
    // The owner's pi profile, whose credentials the reviewer profile links to.
    piMainDir: env["PI_MAIN_DIR"] ?? env["PI_CODING_AGENT_DIR"] ?? join(home, ".pi", "agent"),
  };
}

export const usageLine = "usage: npm run review -- <pr> [--dry-run] [--force]";

// `help` is handled by the caller; anything else that is not a PR number or a known flag throws.
export function parseArgs(argv: readonly string[]) {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  if (argv.includes("--help") || argv.includes("-h")) return { help: true, pr: 0, dryRun, force };
  const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--dry-run" && arg !== "--force");
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(" ")}\n${usageLine}`);
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const pr = Number(positional[0]);
  if (positional.length !== 1 || !Number.isInteger(pr) || pr < 1) throw new Error(usageLine);
  return { help: false, pr, dryRun, force };
}
