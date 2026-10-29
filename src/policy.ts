import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";
import type { Manifest } from "./manifest.ts";

export const APPROVE = "Review each finding and accept it with a reason";
export const FIX = "Make the model fix it";
export const STOP = "Leave it as is";

/** Finding lines of an agentlint report ("rule/id path:line"), for the question shown to the user. */
export const policyFindings = (report: string) => report.split("\n").filter((l) => /^\S+\/\S+\s+\S+:\d+/.test(l.trim())).slice(0, 5);

/** One finding from `agentlint next --format json`, as the user reads it before deciding. */
export const describeFinding = (f: any) =>
  [
    `${f?.ruleTitle ?? f?.ruleId ?? "agentlint finding"}`,
    `${f?.file ?? "?"}:${f?.line ?? "?"}: ${f?.message ?? ""}`,
    ...(f?.guidance?.standard ? [`Rule: ${f.guidance.standard}`] : []),
    ...(f?.proposal?.summary ? [`Agent's note: ${f.proposal.summary}`] : []),
  ].join("\n");

/**
 * agentlint blocks and the model cannot decide: the user does, here, instead of paying another model round.
 * Each finding is shown and accepted with its own reason (agentlint's rule: never bulk-accept with one generic reason);
 * an empty reason hands the rest back to the model. `agentlint approve` needs a human actor: the user is the one
 * answering in the UI, so we declare them (pi.exec has no TTY and may run inside another agent, which agentlint would otherwise detect).
 */
export async function resolvePolicyFailure(pi: ExtensionAPI, ctx: ExtensionContext, manifest: Manifest, report: string): Promise<"approved" | "fix" | "stop" | "failed"> {
  const findings = policyFindings(report);
  const choice = await ctx.ui.select(`agentlint blocks the finish:\n${findings.join("\n") || report.slice(-300)}\nWhat now?`, [APPROVE, FIX, STOP]);
  if (choice === FIX) return "fix";
  if (choice !== APPROVE) return "stop";
  const cmd = manifest.agentlint ?? resolveBin("agentlint");
  // userInfo() throws when the uid has no passwd entry (containers, some CI).
  let user = process.env.USER ?? "user";
  try {
    user = os.userInfo().username;
  } catch {}
  // User text goes in as argv, never inside the shell string. `-l`: a login shell loads PATH from nvm/asdf, like the verify steps.
  const run = (...args: string[]) => pi.exec("bash", ["-lc", `export AGENTLINT_ACTOR="$1"; shift; ${cmd} "$@"`, "agentlint", `human:${user}`, ...args], { cwd: ctx.cwd, timeout: 120_000 });
  // `next` reports the next open finding; null when its output cannot be read.
  const next = async (): Promise<{ selector: string; finding: any } | "" | null> => {
    try {
      const parsed = JSON.parse((await run("next", "--format", "json")).stdout);
      return parsed?.remaining && parsed.selector ? { selector: parsed.selector as string, finding: parsed.finding } : "";
    } catch {
      return null;
    }
  };
  // Selectors are numbered per check, so a finding is told apart by selector and content: one that returns after its approve was not recorded.
  const accepted = new Set<string>();
  for (;;) {
    const open = await next();
    if (open === null) return "failed";
    if (!open) {
      if (accepted.size) return "approved";
      // Nothing to accept, yet verify fails on agentlint: retrying would fail the same way and ask again.
      ctx.ui.notify("agentlint reports no open finding, but verify still fails on it. Nothing was accepted; run agentlint by hand to see why.", "warning");
      return "failed";
    }
    const f = open.finding;
    const id = JSON.stringify([open.selector, f?.ruleId, f?.file, f?.line, f?.message]);
    if (accepted.has(id)) {
      ctx.ui.notify(`agentlint still reports ${f?.file ?? "a finding"}:${f?.line ?? "?"} after it was accepted, so the acceptance did not hold. Stopping.`, "warning");
      return "failed";
    }
    accepted.add(id);
    const reason = ((await ctx.ui.input(`${describeFinding(f)}\n\nWhy is this right as it is? (recorded in .agentlint/acceptances.jsonl; empty: the model fixes it)`)) ?? "").trim();
    if (!reason) return "fix";
    const accept = await run("approve", "--reason", reason, open.selector);
    if (accept.code !== 0) return "failed";
  }
}
