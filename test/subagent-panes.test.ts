import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { busyRuns, ownRuns, syncPanes } from "../src/subagent-panes.ts";
import { tempDir } from "./helpers.ts";

async function run(dir: string, handle: string, meta: object) {
  await fs.mkdir(path.join(dir, handle), { recursive: true });
  await fs.writeFile(path.join(dir, handle, "metadata.json"), JSON.stringify({ handle, tmuxSession: `pi-subagent-${handle}`, ...meta }));
}

test("busyRuns lists this session's working children, and the ones runSubagent spawned, oldest first", async () => {
  const dir = await tempDir();
  await run(dir, "b2", { parentSessionId: "s1", state: "busy", createdAt: "2026-10-27T02" });
  await run(dir, "a1", { parentSessionId: "s1", state: "busy", createdAt: "2026-10-27T01" });
  await run(dir, "c3", { parentSessionId: "s1", state: "idle", createdAt: "2026-10-27T00" });
  await run(dir, "d4", { parentSessionId: "other", state: "busy", createdAt: "2026-10-27T00" });
  await run(dir, "e5", { state: "busy", createdAt: "2026-10-27T03" });
  await fs.mkdir(path.join(dir, "broken"));
  assert.deepEqual(busyRuns("s1", dir).map((r) => r.handle), ["a1", "b2"]);
  ownRuns.add("e5");
  try {
    assert.deepEqual(busyRuns("s1", dir), [
      { handle: "a1", tmux: "pi-subagent-a1" },
      { handle: "b2", tmux: "pi-subagent-b2" },
      { handle: "e5", tmux: "pi-subagent-e5" },
    ]);
  } finally {
    ownRuns.delete("e5");
  }
  assert.deepEqual(busyRuns("s1", path.join(dir, "missing")), []);
});

test("syncPanes opens a pane per working child, stacks them, and closes the ones that stopped working", async () => {
  const calls: string[][] = [];
  let next = 100;
  const tern = async (args: string[]) => {
    calls.push(args);
    return args[0] === "split" ? `{"session":1,"tab":2,"block":${next++}}` : "";
  };
  const panes = new Map<string, string>();
  const a = { handle: "a1", tmux: "pi-subagent-a1" };
  const b = { handle: "b2", tmux: "pi-subagent-b2" };

  await syncPanes(panes, [a, b], "7", tern);
  assert.deepEqual(calls, [
    ["split", "7", "right", "--json", "--", "tmux", "attach", "-t", "pi-subagent-a1"],
    ["split", "100", "down", "--json", "--", "tmux", "attach", "-t", "pi-subagent-b2"],
  ]);
  calls.length = 0;
  await syncPanes(panes, [a, b], "7", tern);
  assert.deepEqual(calls, []);
  await syncPanes(panes, [b], "7", tern);
  assert.deepEqual(calls, [["close", "100"]]);
  await syncPanes(panes, [], "7", tern);
  assert.deepEqual(panes, new Map());
});

test("syncPanes starts beside pi again when the last pane is gone, and skips a pane tern could not open", async () => {
  const calls: string[][] = [];
  const tern = async (args: string[]) => {
    calls.push(args);
    return args[0] === "split" && args[1] === "7" ? `{"block":200}` : "";
  };
  const panes = new Map([["a1", "100"]]);
  await syncPanes(panes, [{ handle: "a1", tmux: "x" }, { handle: "b2", tmux: "y" }], "7", tern);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["split", "100", "down"], ["split", "7", "right"]]);
  assert.equal(panes.get("b2"), "200");

  const failing = new Map<string, string>();
  await syncPanes(failing, [{ handle: "c3", tmux: "z" }], "7", async () => "");
  assert.equal(failing.get("c3"), "");
  calls.length = 0;
  await syncPanes(failing, [], "7", tern);
  assert.deepEqual(calls, []);
});
