import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import extension from "../src/index.ts";
import { agentDir, ensureTrusted, hasGlobalSubagent, loadBundledSubagent } from "../src/subagent-ext.ts";
import { fakePi, tempProject, withEnv } from "./helpers.ts";

test("global pi-subagent is detected from extensions/ or settings packages", async () => {
  const none = await tempProject({});
  assert.equal(hasGlobalSubagent(none), false);
  const ext = await tempProject({ "extensions/subagent/index.ts": "export default () => {}" });
  assert.equal(hasGlobalSubagent(ext), true);
  const pkg = await tempProject({ "settings.json": JSON.stringify({ packages: ["git:github.com/badlogic/pi-subagent"] }) });
  assert.equal(hasGlobalSubagent(pkg), true);
  assert.equal(await loadBundledSubagent({} as any, pkg), "global");
});

test("ensureTrusted adds the project once and keeps other entries", async () => {
  const dir = await tempProject({ "trust.json": JSON.stringify({ "/other": true }) });
  assert.equal(await ensureTrusted("/proj", dir), true);
  assert.equal(await ensureTrusted("/proj", dir), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "trust.json"), "utf8")), { "/other": true, "/proj": true });
});

test("ensureTrusted leaves a corrupt trust file untouched and trusts nothing", async () => {
  const dir = await tempProject({ "trust.json": "{not json" });
  assert.equal(await ensureTrusted("/proj", dir), false);
  assert.equal(await fs.readFile(path.join(dir, "trust.json"), "utf8"), "{not json");
  assert.deepEqual((await fs.readdir(dir)).sort(), ["trust.json"]);
});

test("hasGlobalSubagent accepts object entries in settings packages", async () => {
  const dir = await tempProject({ "settings.json": JSON.stringify({ packages: [{ source: "npm:@earendil-works/pi-subagent" }] }) });
  assert.equal(hasGlobalSubagent(dir), true);
});

test("a ~ or file:// agent dir is expanded the way pi does, so a global pi-subagent there is found", async () => {
  const home = await tempProject({ "agent/extensions/subagent/index.ts": "" });
  await withEnv({ HOME: home, PI_CODING_AGENT_DIR: "~/agent" }, async () => {
    assert.equal(agentDir(), path.join(home, "agent"));
    assert.equal(hasGlobalSubagent(), true);
  });
  await withEnv({ PI_CODING_AGENT_DIR: pathToFileURL(path.join(home, "agent")).href }, async () => {
    assert.equal(agentDir(), path.join(home, "agent"));
    assert.equal(hasGlobalSubagent(), true);
  });
});

test("tests run against a temp agent dir, never the real one", () => {
  assert.notEqual(path.resolve(agentDir()), path.join(os.homedir(), ".pi", "agent"));
});

test("the extension registers nothing inside a subagent child", async () => {
  const { pi, tools, commands } = fakePi();
  const agent = await tempProject({ "extensions/subagent/index.ts": "export default () => {}" }); // a global subagent, so the bundled one is not loaded
  await withEnv({ PI_SUBAGENT_RUN_DIR: "/tmp/run", PI_CODING_AGENT_DIR: agent }, () => extension(pi));
  assert.equal(tools.size + commands.size, 0);
});

test("the bundled pi-subagent keeps its commands and events, but not its /subagent or its widget", async () => {
  const { pi, commands, emit } = fakePi();
  const ext = await import("../src/subagent-ext.ts");
  const host = ext.subagentHost(pi);
  const widgets: string[] = [];
  const notes: string[] = [];
  host.registerCommand("subagent", { handler: async () => {} } as any);
  host.registerCommand("other", { handler: async () => {} } as any);
  host.on("session_start", (_e: any, ctx: any) => {
    ctx.ui.setWidget("subagents", ["x"]);
    ctx.ui.notify("hi");
    widgets.push(ctx.sessionManager.getSessionId());
  });
  assert.deepEqual([...commands.keys()], ["other"]);
  assert.ok(ext.bundledCommand);
  await emit("session_start", {}, { sessionManager: { getSessionId: () => "s1" }, ui: { setWidget: (k: string) => widgets.push(k), notify: (t: string) => notes.push(t) } });
  assert.deepEqual(widgets, ["s1"]);
  assert.deepEqual(notes, ["hi"]);
});
