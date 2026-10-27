import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";
import type { Manifest } from "./manifest.ts";

const MAX_ACCEPTS = 10;
export const APPROVE = "Approve the exception";
export const FIX = "Make the model fix it";
export const STOP = "Leave it as is";

/** Finding lines of an agentlint report ("rule/id path:line"), for the question shown to the user. */
export const policyFindings = (report: string) => report.split("\n").filter((l) => /^\S+\/\S+\s+\S+:\d+/.test(l.trim())).slice(0, 5);

/**
 * agentlint blocks and the model cannot decide: the user does, here, instead of paying another model round.
 * On approval every remaining finding is approved with the user's reason, through the project's agentlint command.
 * `agentlint approve` needs a human actor: the user just chose "approve" in the UI, so we declare them (pi.exec has
 * no TTY and may run inside another agent, which agentlint would otherwise detect).
 */
export async function resolvePolicyFailure(pi: ExtensionAPI, ctx: ExtensionContext, manifest: Manifest, report: string): Promise<"approved" | "fix" | "stop" | "failed"> {
  const findings = policyFindings(report);
  const choice = await ctx.ui.select(`agentlint blocks the finish:\n${findings.join("\n") || report.slice(-300)}\nWhat now?`, [APPROVE, FIX, STOP]);
  if (choice === FIX) return "fix";
  if (choice !== APPROVE) return "stop";
  const reason = ((await ctx.ui.input("Reason for the exception (recorded in .agentlint/acceptances.jsonl)")) ?? "").trim();
  if (!reason) return "fix";
  const cmd = manifest.agentlint ?? resolveBin("agentlint");
  // userInfo() throws when the uid has no passwd entry (containers, some CI).
  let user = process.env.USER ?? "user";
  try {
    user = os.userInfo().username;
  } catch {}
  // User text goes in as argv, never inside the shell string. `-l`: a login shell loads PATH from nvm/asdf, like the verify steps.
  const run = (...args: string[]) => pi.exec("bash", ["-lc", `export AGENTLINT_ACTOR="$1"; shift; ${cmd} "$@"`, "agentlint", `human:${user}`, ...args], { cwd: ctx.cwd, timeout: 120_000 });
  // `next` reports what is left; null when its output cannot be read.
  const remaining = async () => {
    try {
      const parsed = JSON.parse((await run("next", "--format", "json")).stdout);
      return parsed?.remaining && parsed.selector ? (parsed.selector as string) : "";
    } catch {
      return null;
    }
  };
  for (let i = 0; i < MAX_ACCEPTS; i++) {
    const selector = await remaining();
    if (selector === null) return "failed";
    if (!selector) return "approved";
    const accept = await run("approve", "--reason", reason, selector);
    if (accept.code !== 0) return "failed";
  }
  // The cap is a safety stop: approve only if nothing is left after the last acceptance.
  return (await remaining()) === "" ? "approved" : "failed";
}
