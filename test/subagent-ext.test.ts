import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { ensureTrusted, hasGlobalSubagent, loadBundledSubagent } from "../src/subagent-ext.ts";
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
