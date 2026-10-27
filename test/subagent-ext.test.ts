import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { agentDir, ensureTrusted, hasGlobalSubagent, loadBundledSubagent } from "../src/subagent-ext.ts";
import { tempProject } from "./helpers.ts";

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

test("tests run against a temp agent dir, never the real one", () => {
  assert.notEqual(path.resolve(agentDir()), path.join(os.homedir(), ".pi", "agent"));
});
