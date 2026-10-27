import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";

const run = promisify(execFile);

/** Handles of this session's children that are still working, read from `subagent list` (it filters by PI_SESSION_ID). */
export function activeHandles(listing: string): string[] {
  return [...listing.matchAll(/^(?:.* \()?([0-9a-f]+)\)?\s+(?:busy|starting)\s/gm)].map((m) => m[1]);
}

/** Stops the children this session spawned that are still working. Never throws. */
export async function stopChildren(sessionId: string, cwd: string) {
  const env = { ...process.env, PI_SESSION_ID: sessionId };
  const bin = resolveBin("subagent");
  try {
    const { stdout } = await run(bin, ["list"], { cwd, env, timeout: 30_000 });
    await Promise.all(activeHandles(stdout).map((h) => run(bin, ["stop", h], { cwd, env, timeout: 30_000 }).catch(() => {})));
  } catch {}
}

// Escape aborts the parent run but the children, each in its own tmux session, would keep working. pi emits agent_settled
// (not agent_before_settle) on abort.
export function registerAbortCleanup(pi: ExtensionAPI) {
  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) await stopChildren(ctx.sessionManager.getSessionId(), ctx.cwd);
  });
}
