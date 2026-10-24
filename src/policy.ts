import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";
import { agentlintCmd } from "./discover.ts";
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
  const cmd = manifest.agentlint ?? agentlintCmd("npm", false) ?? resolveBin("agentlint");
  const actor = `AGENTLINT_ACTOR=human:${os.userInfo().username}`;
  const run = (args: string) => pi.exec("bash", ["-lc", `${actor} ${cmd} ${args}`], { cwd: ctx.cwd, timeout: 120_000 });
  for (let i = 0; i < MAX_ACCEPTS; i++) {
    const next = await run("next --format json");
    let parsed: any;
    try {
      parsed = JSON.parse(next.stdout);
    } catch {
      return "failed";
    }
    if (!parsed?.remaining || !parsed.selector) return "approved";
    const accept = await run(`approve --reason ${JSON.stringify(reason)} ${JSON.stringify(parsed.selector)}`);
    if (accept.code !== 0) return "failed";
  }
  return "approved";
}
