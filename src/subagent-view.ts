import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, bundledCommand } from "./subagent-ext.ts";

export type Tern = (args: string[]) => Promise<string | undefined>;
export type Paint = (color: "accent" | "success" | "error" | "muted", text: string) => string;
export interface Run {
  handle: string;
  name: string;
  tmux: string;
  state: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  sessionFile: string;
}
export interface Activity {
  turns: number;
  tools: number;
  tokens: number;
  doing: string;
}
export interface Pane {
  block: string;
  manual: boolean;
}

/** Handles runSubagent spawned in this process: pi.exec passes no PI_SESSION_ID, so their metadata names no parent. */
export const ownRuns = new Set<string>();

const WIDGET = "pi-improved-subagents";
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const MAX_LINES = 10; // pi shows at most 10 widget lines
const KEEP_FINISHED = 5 * 60_000; // a child that stopped working leaves the widget after this long

const tern: Tern = (args) => new Promise((resolve) => execFile("tern", args, { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout)));
const tmuxSessions = () =>
  new Promise<Set<string>>((resolve) => execFile("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 5_000 }, (err, stdout) => resolve(new Set(err ? [] : stdout.split("\n")))));

/** This session's children whose tmux session is alive, oldest first. */
export function sessionRuns(sessionId: string, live: Set<string>, dir = path.join(agentDir(), "subagents")): Run[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs = names.flatMap((name) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name, "metadata.json"), "utf8"));
      return m && typeof m === "object" ? [m] : [];
    } catch {
      return [];
    }
  });
  return runs
    .filter((m) => (m.parentSessionId === sessionId || ownRuns.has(m.handle)) && live.has(m.tmuxSession))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((m) => ({
      handle: m.handle,
      name: m.name ?? m.handle,
      tmux: m.tmuxSession,
      state: m.state,
      model: `${m.model}·${m.thinking}`,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      sessionFile: m.sessionFile,
    }));
}

const read = new Map<string, { size: number; activity: Activity }>();

/** Turns, tool calls, context tokens and the tool running now, from the child's session file. */
export function activity(file: string): Activity {
  let size = -1;
  try {
    size = fs.statSync(file).size;
  } catch {}
  const cached = read.get(file);
  if (cached?.size === size) return cached.activity;
  const a: Activity = { turns: 0, tools: 0, tokens: 0, doing: "" };
  let pending: string[] = [];
  let last = "";
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  for (const line of text.split("\n")) {
    let m: any;
    try {
      m = JSON.parse(line).message;
    } catch {
      continue; // blank, or the line pi is still writing
    }
    if (!m?.role) continue;
    if (m.role === "assistant") {
      const calls = Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "toolCall").map((b: any) => b.name) : [];
      a.turns++;
      a.tools += calls.length;
      a.tokens = m.usage?.totalTokens ?? a.tokens;
      pending = calls;
    } else if (m.role === "toolResult") pending.shift();
    else pending = [];
    last = m.role;
  }
  a.doing = pending[0] ?? (last === "assistant" ? "" : "thinking…");
  read.set(file, { size, activity: a });
  return a;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

const isWorking = (r: Run) => r.state === "busy" || r.state === "starting";

/** One line per child, cut to `width`: `⠋ [S] review · read · 2 turns · 5 tools · gpt-6-astra·medium · 12.3k tok · 41s`. */
export function runLine(r: Run, a: Activity, now: number, frame: number, paint: Paint = (_c, t) => t, width = Infinity): string {
  const working = isWorking(r);
  const icon = r.state === "busy" ? SPINNER[frame % SPINNER.length] : r.state === "idle" ? "✓" : r.state === "error" ? "✗" : "…";
  const doing = r.state === "busy" ? a.doing || "thinking…" : r.state === "starting" ? "starting…" : r.state;
  const end = working ? now : Date.parse(r.updatedAt) || now;
  const stats = [plural(a.turns, "turn"), plural(a.tools, "tool"), r.model, `${tokens(a.tokens)} tok`, elapsed(end - Date.parse(r.createdAt))];
  const color = r.state === "idle" ? "success" : r.state === "error" ? "error" : "accent";
  const head = `${icon} [S]`;
  const body = ` ${r.name} · ${doing} · `;
  let text = [...`${head}${body}${stats.join(" · ")}`];
  if (text.length > width) text = [...text.slice(0, Math.max(0, width - 1)), "…"];
  const [h, b] = [[...head].length, [...head].length + [...body].length];
  return paint(color, text.slice(0, h).join("")) + text.slice(h, b).join("") + paint("muted", text.slice(b).join(""));
}

/** The widget's lines: working children, and the ones that stopped working less than 5 minutes ago (`/subagent` lists all). */
export function widgetLines(all: Run[], now: number, frame: number, paint: Paint = (_c, t) => t, width = Infinity): string[] {
  // pi-subagent stamps updatedAt when the state changes, so for a finished child it is when it finished.
  const runs = all.filter((r) => isWorking(r) || now - (Date.parse(r.updatedAt) || now) < KEEP_FINISHED);
  const shown = runs.length > MAX_LINES ? runs.slice(0, MAX_LINES - 1) : runs;
  const lines = shown.map((r) => runLine(r, activity(r.sessionFile), now, frame, paint, width));
  if (shown.length < runs.length) lines.push(paint("muted", `+${runs.length - shown.length} more · /subagent`));
  return lines;
}

/** Opens a pane attached to the child's tmux session: below the last pane, else right of `anchor` (pi's pane). */
async function openPane(panes: Map<string, Pane>, r: Run, anchor: string, run: Tern, manual: boolean) {
  const attach = ["--json", "--", "tmux", "attach", "-t", r.tmux];
  const last = [...panes.values()].map((p) => p.block).filter(Boolean).at(-1);
  // The last pane may be gone (closed by hand); then start a new column beside pi.
  const out = (last && (await run(["split", last, "down", ...attach]))) || (await run(["split", anchor, "right", ...attach]));
  const block = /"block":\s*(\d+)/.exec(out ?? "")?.[1] ?? "";
  panes.set(r.handle, { block, manual });
  return block;
}

/**
 * Opens a pane for each busy child and closes the panes of children that stopped working. A pane opened from
 * `/subagent` (manual) stays until its child is gone. `panes` maps a handle to its pane ("" when tern could not open it).
 */
export async function syncPanes(panes: Map<string, Pane>, runs: Run[], anchor: string, run: Tern = tern) {
  for (const [handle, pane] of panes) {
    const r = runs.find((x) => x.handle === handle);
    if (r && (r.state === "busy" || pane.manual)) continue;
    panes.delete(handle);
    // A stopped child ends its tmux session and the pane closes by itself; an idle one is still attached.
    if (pane.block) await run(["close", pane.block]);
  }
  for (const r of runs) if (r.state === "busy" && !panes.has(r.handle)) await openPane(panes, r, anchor, run, false);
}

/** Focuses the child's pane, or opens one (kept until the child is gone) when it has none or it was closed. */
export async function showPane(panes: Map<string, Pane>, r: Run, anchor: string, run: Tern = tern) {
  const pane = panes.get(r.handle);
  if (pane?.block && (await run(["focus", pane.block])) !== undefined) return (pane.manual = true);
  panes.delete(r.handle);
  const block = await openPane(panes, r, anchor, run, true);
  return !!block && (await run(["focus", block])) !== undefined;
}

// view: pi-improved loaded its own pi-subagent, whose widget and `/subagent` give way to these (see subagentHost).
// The widget lists this session's children, plan check and review included, until 5 minutes after one finishes. In
// Tern (TERN_PANE is the pane pi runs in), each working child gets a pane beside pi attached to its tmux session, so
// you can watch it or type to steer it; focus stays on pi and the pane closes when the child goes idle or stops.
// `/subagent` focuses or opens one.
export function registerSubagentView(pi: ExtensionAPI, view: boolean, run: Tern = tern, live = tmuxSessions) {
  const anchor = process.env.TERN_PANE;
  if (!anchor && !view) return;
  const panes = new Map<string, Pane>();
  let timer: ReturnType<typeof setInterval> | undefined;
  // One pane change at a time: the timer and `/subagent` would otherwise both open a pane for the same child.
  let lock = Promise.resolve();
  let queued = false;
  let frame = 0;
  // A `/subagent` pick that comes back after shutdown opens no pane: nothing would close it.
  let stopped = false;

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    if (!ctx.hasUI) return;
    clearInterval(timer);
    const paint: Paint = (color, text) => ctx.ui.theme.fg(color, text);
    const tick = async () => {
      const runs = sessionRuns(ctx.sessionManager.getSessionId(), await live());
      // One row per child: pi pads widget lines by one column on each side and wraps longer ones.
      const width = (process.stdout.columns || 80) - 2;
      if (view) {
        const lines = widgetLines(runs, Date.now(), frame++, paint, width);
        ctx.ui.setWidget(WIDGET, lines.length ? lines : undefined);
      }
      if (anchor) await syncPanes(panes, runs, anchor, run);
    };
    timer = setInterval(() => {
      if (queued) return;
      queued = true;
      lock = lock.then(tick).catch(() => {}).finally(() => (queued = false));
    }, 1000);
    timer.unref();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    clearInterval(timer);
    timer = undefined;
    if (view && ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    if (anchor) await (lock = lock.then(() => syncPanes(panes, [], anchor, run)));
  });

  if (!view) return;
  pi.registerCommand("subagent", {
    description: "Show a subagent spawned by this session (in Tern, focus or open its pane)",
    handler: async (args, ctx) => {
      if (!anchor) return bundledCommand?.handler(args, ctx);
      const runs = sessionRuns(ctx.sessionManager.getSessionId(), await live());
      if (runs.length === 0) return ctx.ui.notify("No active subagents spawned by this session", "info");
      const now = Date.now();
      const labels = runs.map((r) => runLine({ ...r, name: `${r.name} (${r.handle})` }, activity(r.sessionFile), now, 0));
      const picked = runs[labels.indexOf((await ctx.ui.select("Show subagent", labels)) ?? "")];
      if (!picked) return;
      let shown = false;
      await (lock = lock.then(async () => void (shown = !stopped && (await showPane(panes, picked, anchor, run)))));
      if (!shown && !stopped) ctx.ui.notify(`Could not open a pane for ${picked.name}`, "error");
    },
  });
}
