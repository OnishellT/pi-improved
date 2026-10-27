import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./subagent-ext.ts";

export type Tern = (args: string[]) => Promise<string>;
export interface BusyRun {
  handle: string;
  tmux: string;
}

/** Handles runSubagent spawned in this process: pi.exec passes no PI_SESSION_ID, so their metadata names no parent. */
export const ownRuns = new Set<string>();

const tern: Tern = (args) => new Promise((resolve) => execFile("tern", args, { timeout: 10_000 }, (err, stdout) => resolve(err ? "" : stdout)));

/** This session's children that are working now, oldest first. */
export function busyRuns(sessionId: string, dir = path.join(agentDir(), "subagents")): BusyRun[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs = names.flatMap((name) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(dir, name, "metadata.json"), "utf8"))];
    } catch {
      return [];
    }
  });
  return runs
    .filter((m) => (m.parentSessionId === sessionId || ownRuns.has(m.handle)) && m.state === "busy")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((m) => ({ handle: m.handle, tmux: m.tmuxSession }));
}

/**
 * Opens a pane for each busy run and closes the panes of runs that are no longer busy. The first pane goes right of
 * `anchor`, the next ones below the last. `panes` maps a handle to its block id ("" when tern could not open it).
 */
export async function syncPanes(panes: Map<string, string>, busy: BusyRun[], anchor: string, run: Tern = tern) {
  for (const [handle, block] of panes) {
    if (busy.some((r) => r.handle === handle)) continue;
    panes.delete(handle);
    // A stopped child ends its tmux session and the pane closes by itself; an idle one is still attached.
    if (block) await run(["close", block]);
  }
  for (const r of busy) {
    if (panes.has(r.handle)) continue;
    const attach = ["--json", "--", "tmux", "attach", "-t", r.tmux];
    const last = [...panes.values()].filter(Boolean).at(-1);
    // The last pane may be gone (closed by hand); then start a new column beside pi.
    const out = (last && (await run(["split", last, "down", ...attach]))) || (await run(["split", anchor, "right", ...attach]));
    panes.set(r.handle, /"block":\s*(\d+)/.exec(out)?.[1] ?? "");
  }
}

// In Tern (TERN_PANE is the pane pi runs in), each working child gets a pane beside pi attached to its tmux session,
// so you can watch it or type to steer it. Focus stays on pi; the pane closes when the child goes idle or stops.
export function registerSubagentPanes(pi: ExtensionAPI, run: Tern = tern) {
  const anchor = process.env.TERN_PANE;
  if (!anchor) return;
  const panes = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearInterval(timer);
    timer = setInterval(() => {
      if (syncing) return;
      syncing = true;
      syncPanes(panes, busyRuns(ctx.sessionManager.getSessionId()), anchor, run).finally(() => (syncing = false));
    }, 1000);
    timer.unref();
  });
  pi.on("session_shutdown", async () => {
    clearInterval(timer);
    timer = undefined;
    await syncPanes(panes, [], anchor, run);
  });
}
