import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGlobal } from "./config.ts";
import { nixPackage } from "./nix.ts";
import { agentDir, bundledCommand } from "./subagent-ext.ts";

/** Runs a terminal CLI (`tern` or `tmux`): its stdout, or undefined when it failed. */
export type Tern = (args: string[]) => Promise<string | undefined>;
/** Where a child's pane goes: `anchor` is pi's pane. Both backends open it beside pi, attached to the child's tmux session. */
export interface Backend {
  /** Splits `target` to the right or below, attached to `session`. Returns the new pane's id, "" when it could not open. */
  split(target: string, dir: "right" | "down", session: string): Promise<string>;
  close(pane: string): Promise<void>;
  focus(pane: string): Promise<boolean>;
}
export interface Panes {
  anchor: string;
  backend: Backend;
}
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
const RETRY_BUILD = 60_000;
/**
 * The pinned Nix tmux, the one the subagent CLI creates children with (a machine may have no other). Never waits: it is
 * undefined while the build runs (the first one takes minutes), for a minute after a failed one and without Nix, and
 * the system tmux answers meanwhile. One build at a time, so widget ticks neither queue behind it nor restart it.
 */
export function pinnedTmux(resolve: (attr: string) => Promise<string> = nixPackage, now = Date.now): () => Promise<string | undefined> {
  let bin: string | undefined;
  let building = false;
  let failedAt = -Infinity;
  return async () => {
    if (!bin && !building && now() - failedAt >= RETRY_BUILD) {
      building = true;
      resolve("tmux")
        .then((out) => void (bin = path.join(out, "bin", "tmux")), () => void (failedAt = now()))
        .finally(() => (building = false));
    }
    return bin;
  };
}
const tmuxBin = pinnedTmux();
const tmux: Tern = async (args) => {
  const bin = await tmuxBin();
  return bin && new Promise((resolve) => execFile(bin, args, { timeout: 5_000 }, (err, stdout) => resolve(err ? undefined : stdout)));
};
/** The tmux on PATH: the fallback when the pinned one cannot split (a different version than the server pi runs in). */
const systemTmux: Tern = (args) => new Promise((resolve) => execFile("tmux", args, { timeout: 5_000 }, (err, stdout) => resolve(err ? undefined : stdout)));
const tmuxSessions = async () => new Set((((await tmux(["list-sessions", "-F", "#{session_name}"])) ?? (await systemTmux(["list-sessions", "-F", "#{session_name}"]))) ?? "").split("\n"));

/** This session's children whose tmux session is alive (all of them without `live`), oldest first. */
export function sessionRuns(sessionId: string, live?: Set<string>, dir = path.join(agentDir(), "subagents")): Run[] {
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
    .filter((m) => (m.parentSessionId === sessionId || ownRuns.has(m.handle)) && (!live || live.has(m.tmuxSession)))
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

/** `attach` gives the tmux that runs in the pane: it must be the children's, or a version mismatch keeps it from attaching. */
type Attach = () => Promise<string | undefined>;
const pathTmux: Attach = async () => "tmux";

export const ternBackend = (run: Tern, attach: Attach = pathTmux): Backend => ({
  split: async (target, dir, session) => {
    // The pinned tmux first; if its client cannot attach (version mismatch with the running server), once more with the system one.
    const bin = await attach();
    for (const client of bin === "tmux" ? ["tmux"] : [bin, "tmux"]) {
      const block = client && /"block":\s*(\d+)/.exec((await run(["split", target, dir, "--json", "--", client, "attach", "-t", session])) ?? "")?.[1];
      if (block) return block;
    }
    return "";
  },
  close: async (pane) => void (await run(["close", pane])),
  focus: async (pane) => (await run(["focus", pane])) !== undefined,
});

/**
 * `-d` keeps focus on pi; `env -u TMUX` lets the pane's tmux client attach to another session from inside tmux, and
 * `-S socket` keeps it on pi's server (children inherit $TMUX, so they live there even when it is not the default one).
 */
export const tmuxBackend = (run: Tern, attach: Attach = pathTmux, socket = "", runSystem?: Tern): Backend => ({
  split: async (target, dir, session) => {
    const bin = await attach();
    const attempt = async (r: Tern, tmuxBin: string) =>
      (await r(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", target, dir === "right" ? "-h" : "-v", "env", "-u", "TMUX", tmuxBin, ...(socket ? ["-S", socket] : []), "attach", "-t", session]))?.trim() || "";
    // The pinned tmux first; if it cannot split (a different version than the server pi runs in), once more with the system one.
    return (bin ? await attempt(run, bin) : "") || (runSystem && bin !== "tmux" ? await attempt(runSystem, "tmux") : "");
  },
  // Panes are made by the pinned tmux first, or by the system one; the same goes for closing and focusing them.
  close: async (pane) => void ((await run(["kill-pane", "-t", pane])) ?? (await runSystem?.(["kill-pane", "-t", pane]))),
  focus: async (pane) => (await run(["select-pane", "-t", pane])) !== undefined || (!!runSystem && (await runSystem(["select-pane", "-t", pane])) !== undefined),
});

/** Opt in to Tern with `"subagentPanes": "tern"` in the global file (`pi-improved.json`). */
export function wantsTern(dir = agentDir()): boolean {
  try {
    return readGlobal(dir).subagentPanes === "tern";
  } catch {
    return false;
  }
}

/** Tern when the user opted in and pi runs in it, else tmux when pi runs in tmux, else none (the widget only). */
export function panesFor(env = process.env, optedIn = wantsTern(), run: Tern = tmux, runTern: Tern = tern, attach: Attach = tmuxBin, runSystem: Tern = systemTmux): Panes | undefined {
  if (optedIn && env.TERN_PANE) return { anchor: env.TERN_PANE, backend: ternBackend(runTern, attach) };
  if (env.TMUX && env.TMUX_PANE) return { anchor: env.TMUX_PANE, backend: tmuxBackend(run, attach, env.TMUX.split(",")[0], runSystem) };
  return undefined;
}

/** Opens a pane attached to the child's tmux session: below the last pane, else right of `anchor` (pi's pane). */
async function openPane(panes: Map<string, Pane>, r: Run, anchor: string, backend: Backend, manual: boolean) {
  const last = [...panes.values()].map((p) => p.block).filter(Boolean).at(-1);
  // The last pane may be gone (closed by hand); then start a new column beside pi.
  const block = (last && (await backend.split(last, "down", r.tmux))) || (await backend.split(anchor, "right", r.tmux));
  panes.set(r.handle, { block, manual });
  return block;
}

/**
 * Opens a pane for each busy child and closes the panes of children that stopped working. A pane opened from
 * `/subagent` (manual) stays until its child is gone. `panes` maps a handle to its pane ("" when it could not open).
 */
export async function syncPanes(panes: Map<string, Pane>, runs: Run[], anchor: string, backend: Backend) {
  for (const [handle, pane] of panes) {
    const r = runs.find((x) => x.handle === handle);
    if (r && (r.state === "busy" || pane.manual)) continue;
    panes.delete(handle);
    // A stopped child ends its tmux session and the pane closes by itself; an idle one is still attached.
    if (pane.block) await backend.close(pane.block);
  }
  for (const r of runs) if (r.state === "busy" && !panes.has(r.handle)) await openPane(panes, r, anchor, backend, false);
}

/** Focuses the child's pane, or opens one (kept until the child is gone) when it has none or it was closed. */
export async function showPane(panes: Map<string, Pane>, r: Run, anchor: string, backend: Backend) {
  const pane = panes.get(r.handle);
  if (pane?.block && (await backend.focus(pane.block))) return (pane.manual = true);
  panes.delete(r.handle);
  const block = await openPane(panes, r, anchor, backend, true);
  return !!block && (await backend.focus(block));
}

// view: pi-improved loaded its own pi-subagent, whose widget and `/subagent` give way to these (see subagentHost).
// The widget lists this session's children, plan check and review included, until 5 minutes after one finishes. In
// tmux (or in Tern, when `subagentPanes` opts in), each working child gets a pane beside pi attached to its tmux
// session, so you can watch it or type to steer it; focus stays on pi and the pane closes when the child goes idle
// or stops. `/subagent` focuses or opens one.
export function registerSubagentView(pi: ExtensionAPI, view: boolean, target: Panes | undefined = panesFor(), live = tmuxSessions) {
  if (!target && !view) return;
  const panes = new Map<string, Pane>();
  let timer: ReturnType<typeof setInterval> | undefined;
  // One pane change at a time: the timer and `/subagent` would otherwise both open a pane for the same child.
  let lock = Promise.resolve();
  let queued = false;
  let frame = 0;
  // A `/subagent` pick that comes back after shutdown opens no pane: nothing would close it.
  let stopped = false;
  // The widget asks every second for the whole session: without a child of ours on disk there is no tmux to ask.
  const liveRuns = async (sessionId: string) => {
    const runs = sessionRuns(sessionId);
    if (!runs.length) return runs;
    const alive = await live();
    return runs.filter((r) => alive.has(r.tmux));
  };

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    if (!ctx.hasUI) return;
    clearInterval(timer);
    const paint: Paint = (color, text) => ctx.ui.theme.fg(color, text);
    const tick = async () => {
      const runs = await liveRuns(ctx.sessionManager.getSessionId());
      // One row per child: pi pads widget lines by one column on each side and wraps longer ones.
      const width = (process.stdout.columns || 80) - 2;
      if (view) {
        const lines = widgetLines(runs, Date.now(), frame++, paint, width);
        ctx.ui.setWidget(WIDGET, lines.length ? lines : undefined);
      }
      if (target) await syncPanes(panes, runs, target.anchor, target.backend);
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
    if (target) await (lock = lock.then(() => syncPanes(panes, [], target.anchor, target.backend)));
  });

  if (!view) return;
  pi.registerCommand("subagent", {
    description: "Show a subagent spawned by this session (in tmux or Tern, focus or open its pane)",
    handler: async (args, ctx) => {
      if (!target) return bundledCommand?.handler(args, ctx);
      const runs = await liveRuns(ctx.sessionManager.getSessionId());
      if (runs.length === 0) return ctx.ui.notify("No active subagents spawned by this session", "info");
      const now = Date.now();
      const labels = runs.map((r) => runLine({ ...r, name: `${r.name} (${r.handle})` }, activity(r.sessionFile), now, 0));
      const picked = runs[labels.indexOf((await ctx.ui.select("Show subagent", labels)) ?? "")];
      if (!picked) return;
      let shown = false;
      await (lock = lock.then(async () => void (shown = !stopped && (await showPane(panes, picked, target.anchor, target.backend)))));
      if (!shown && !stopped) ctx.ui.notify(`Could not open a pane for ${picked.name}`, "error");
    },
  });
}
