import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { activity, ownRuns, registerSubagentView, runLine, sessionRuns, showPane, syncPanes, widgetLines, type Pane, type Run } from "../src/subagent-view.ts";
import { fakePi, tempDir, withEnv } from "./helpers.ts";

async function writeRun(dir: string, handle: string, meta: object) {
  await fs.mkdir(path.join(dir, handle), { recursive: true });
  await fs.writeFile(path.join(dir, handle, "metadata.json"), JSON.stringify({ handle, tmuxSession: `pi-subagent-${handle}`, model: "m", thinking: "low", ...meta }));
}

const msg = (message: object) => JSON.stringify({ type: "message", message });
const call = (name: string) => ({ type: "toolCall", name });
const run = (handle: string, state: string, extra: Partial<Run> = {}): Run => ({
  handle,
  name: handle,
  tmux: `pi-subagent-${handle}`,
  state,
  model: "gpt-6-astra·medium",
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:30.000Z",
  sessionFile: "/missing",
  ...extra,
});

/** A fake tern: splits return the next block id, other commands succeed unless `fail` matches. */
function fakeTern(fail: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  let next = 100;
  const tern = async (args: string[]) => {
    calls.push(args);
    if (fail(args)) return undefined;
    return args[0] === "split" ? `{"session":1,"tab":2,"block":${next++}}` : "";
  };
  return { calls, tern };
}

test("sessionRuns lists this session's live children, and the ones runSubagent spawned, oldest first", async () => {
  const dir = await tempDir();
  await writeRun(dir, "b2", { parentSessionId: "s1", state: "busy", createdAt: "2026-10-27T02", name: "review" });
  await writeRun(dir, "a1", { parentSessionId: "s1", state: "idle", createdAt: "2026-10-27T01" });
  await writeRun(dir, "c3", { parentSessionId: "s1", state: "busy", createdAt: "2026-10-27T00" }); // tmux session gone
  await writeRun(dir, "d4", { parentSessionId: "other", state: "busy", createdAt: "2026-10-27T00" });
  await writeRun(dir, "e5", { state: "busy", createdAt: "2026-10-27T03" });
  await fs.mkdir(path.join(dir, "broken"));
  const live = new Set(["pi-subagent-a1", "pi-subagent-b2", "pi-subagent-d4", "pi-subagent-e5"]);
  assert.deepEqual(sessionRuns("s1", live, dir).map((r) => [r.handle, r.name, r.state, r.model]), [
    ["a1", "a1", "idle", "m·low"],
    ["b2", "review", "busy", "m·low"],
  ]);
  ownRuns.add("e5");
  try {
    assert.deepEqual(sessionRuns("s1", live, dir).map((r) => r.handle), ["a1", "b2", "e5"]);
  } finally {
    ownRuns.delete("e5");
  }
  assert.deepEqual(sessionRuns("s1", live, path.join(dir, "missing")), []);
});

test("activity counts turns and tool calls, keeps the last context size, and names the tool running now", async () => {
  const file = path.join(await tempDir(), "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session" }),
    msg({ role: "user", content: [{ type: "text" }] }),
    msg({ role: "assistant", content: [{ type: "text" }, call("ls")], usage: { totalTokens: 4_000 } }),
    msg({ role: "toolResult", content: [] }),
  ];
  await fs.writeFile(file, lines.join("\n") + "\n");
  assert.deepEqual(activity(file), { turns: 1, tools: 1, tokens: 4_000, doing: "thinking…" });
  lines.push(msg({ role: "assistant", content: [call("read"), call("grep")], usage: { totalTokens: 12_345 } }), msg({ role: "toolResult", content: [] }), '{"type":"mess');
  await fs.writeFile(file, lines.join("\n"));
  assert.deepEqual(activity(file), { turns: 2, tools: 3, tokens: 12_345, doing: "grep" });
  lines.splice(-1, 1, msg({ role: "toolResult", content: [] }), msg({ role: "assistant", content: [{ type: "text" }], usage: { totalTokens: 13_000 } }));
  await fs.writeFile(file, lines.join("\n"));
  assert.equal(activity(file).doing, "");
  assert.deepEqual(activity(path.join(path.dirname(file), "missing.jsonl")), { turns: 0, tools: 0, tokens: 0, doing: "thinking…" });
});

test("runLine shows state, activity and stats; the time stops when the child goes idle", () => {
  const now = Date.parse("2026-10-27T10:01:05.000Z");
  const a = { turns: 2, tools: 5, tokens: 12_345, doing: "read" };
  assert.equal(runLine(run("review", "busy"), a, now, 1), "⠙ [S] review · read · 2 turns · 5 tools · gpt-6-astra·medium · 12.3k tok · 1m 05s");
  assert.equal(runLine(run("review", "busy"), { ...a, doing: "" }, now, 0), "⠋ [S] review · thinking… · 2 turns · 5 tools · gpt-6-astra·medium · 12.3k tok · 1m 05s");
  assert.equal(runLine(run("review", "idle"), { turns: 1, tools: 1, tokens: 900, doing: "" }, now, 0), "✓ [S] review · idle · 1 turn · 1 tool · gpt-6-astra·medium · 900 tok · 30s");
  assert.match(runLine(run("x", "starting"), a, now, 0), /^… \[S\] x · starting… · /);
  assert.equal(runLine(run("review", "busy"), a, now, 1, undefined, 30), "⠙ [S] review · read · 2 turns…");
  assert.equal(runLine(run("review", "busy"), a, now, 1, (c, t) => `<${c}>${t}</${c}>`, 12), "<accent>⠙ [S]</accent> revie…<muted></muted>");
  const painted = runLine(run("x", "error"), a, now, 0, (c, t) => `<${c}>${t}</${c}>`);
  assert.match(painted, /^<error>✗ \[S\]<\/error> x · error · <muted>2 turns · .* · 30s<\/muted>$/);
});

test("widgetLines fits pi's 10 widget lines", () => {
  const runs = Array.from({ length: 12 }, (_, i) => run(`r${i}`, "busy"));
  const lines = widgetLines(runs, Date.now(), 0);
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), "+3 more · /subagent");
  assert.equal(widgetLines(runs.slice(0, 10), Date.now(), 0).length, 10);
});

test("widgetLines drops a child 5 minutes after it stopped working", () => {
  const now = Date.parse("2026-10-27T10:00:30.000Z");
  const later = (min: number) => now + min * 60_000;
  const runs = [run("busy", "busy"), run("done", "idle"), run("failed", "error")];
  const names = (at: number, list = runs) => widgetLines(list, at, 0).map((l) => l.split(" ")[2]);
  assert.deepEqual(names(later(4)), ["busy", "done", "failed"]);
  assert.deepEqual(names(later(5)), ["busy"], "a working child stays however long it runs");
  assert.deepEqual(names(later(5), [{ ...runs[1], state: "busy" }]), ["done"], "and comes back when it works again");
  assert.deepEqual(widgetLines(runs.slice(1), later(5), 0), []);
});

test("syncPanes opens a pane per working child, stacks them, and closes the ones that stopped working", async () => {
  const { calls, tern } = fakeTern();
  const panes = new Map<string, Pane>();
  const [a, b] = [run("a1", "busy"), run("b2", "busy")];
  await syncPanes(panes, [a, b, run("c3", "idle")], "7", tern);
  assert.deepEqual(calls, [
    ["split", "7", "right", "--json", "--", "tmux", "attach", "-t", "pi-subagent-a1"],
    ["split", "100", "down", "--json", "--", "tmux", "attach", "-t", "pi-subagent-b2"],
  ]);
  calls.length = 0;
  await syncPanes(panes, [a, b], "7", tern);
  assert.deepEqual(calls, []);
  await syncPanes(panes, [{ ...a, state: "idle" }, b], "7", tern);
  assert.deepEqual(calls, [["close", "100"]]);
  await syncPanes(panes, [], "7", tern);
  assert.deepEqual(panes, new Map());
});

test("syncPanes starts beside pi again when the last pane is gone, and skips a pane tern could not open", async () => {
  const { calls, tern } = fakeTern((args) => args[0] === "split" && args[1] === "100");
  const panes = new Map([["a1", { block: "100", manual: false }]]);
  await syncPanes(panes, [run("a1", "busy"), run("b2", "busy")], "7", tern);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["split", "100", "down"], ["split", "7", "right"]]);
  assert.equal(panes.get("b2")?.block, "100");

  const failing = new Map<string, Pane>();
  await syncPanes(failing, [run("c3", "busy")], "7", async () => undefined);
  assert.equal(failing.get("c3")?.block, "");
  calls.length = 0;
  await syncPanes(failing, [], "7", tern);
  assert.deepEqual(calls, []);
});

test("showPane focuses an open pane, reopens a closed one, and keeps it while the child is idle", async () => {
  const { calls, tern } = fakeTern((args) => args[0] === "focus" && args[1] === "50");
  const panes = new Map([["a1", { block: "200", manual: false }], ["b2", { block: "50", manual: false }]]);
  assert.equal(await showPane(panes, run("a1", "busy"), "7", tern), true);
  assert.deepEqual(calls, [["focus", "200"]]);
  calls.length = 0;
  // b2's pane was closed by hand: focusing it fails, so a new one opens and gets the focus.
  assert.equal(await showPane(panes, run("b2", "idle"), "7", tern), true);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["focus", "50"], ["split", "200", "down"], ["focus", "100"]]);
  calls.length = 0;
  await syncPanes(panes, [run("a1", "idle"), run("b2", "idle")], "7", tern);
  assert.deepEqual(calls, [], "panes opened from /subagent stay while their child is idle");
  await syncPanes(panes, [], "7", tern);
  assert.deepEqual(calls, [["close", "200"], ["close", "100"]]);
});

test("/subagent opens the picked child's pane in Tern and falls back to pi-subagent's attach elsewhere", async () => {
  const agent = await tempDir();
  const dir = path.join(agent, "subagents");
  await writeRun(dir, "a1", { parentSessionId: "s1", state: "idle", name: "facts", createdAt: "2026-10-27T01" });
  const live = async () => new Set(["pi-subagent-a1"]);
  const notes: string[] = [];
  const ctx = (pick: (labels: string[]) => string | undefined) => ({
    sessionManager: { getSessionId: () => "s1" },
    ui: { select: async (_t: string, labels: string[]) => pick(labels), notify: (text: string) => void notes.push(text) },
  });

  const { calls, tern } = fakeTern();
  const h = fakePi();
  await withEnv({ TERN_PANE: "7", PI_CODING_AGENT_DIR: agent }, async () => {
    registerSubagentView(h.pi, true, tern, live);
    let labels: string[] = [];
    await h.commands.get("subagent").handler("", ctx((l) => ((labels = l), l[0])));
    assert.match(labels[0], /^✓ \[S\] facts \(a1\) · idle · 0 turns/);
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["split", "7", "right"], ["focus", "100"]]);
    calls.length = 0;
    await h.commands.get("subagent").handler("", ctx(() => undefined));
    assert.deepEqual(calls, [], "cancelling opens nothing");
  });

  const plain = fakePi();
  await withEnv({ TERN_PANE: undefined }, async () => registerSubagentView(plain.pi, true, tern, live));
  const { subagentHost } = await import("../src/subagent-ext.ts");
  let attached = "";
  subagentHost(plain.pi).registerCommand("subagent", { handler: async (args: string) => void (attached = args || "attach") } as any);
  await plain.commands.get("subagent").handler("", ctx(() => undefined));
  assert.equal(attached, "attach");

  const none = fakePi();
  await withEnv({ TERN_PANE: undefined }, async () => registerSubagentView(none.pi, false, tern, live));
  assert.equal(none.commands.size, 0, "with a global pi-subagent, its own /subagent stays");
});
