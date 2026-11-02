import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { readGlobal, updateGlobal } from "../src/config.ts";
import { migrateGlobal, migrateProject } from "../src/legacy-config.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { tempProject } from "./helpers.ts";

test("a moved legacy file is renamed, so removing the key later does not copy the old value back", async () => {
  const dir = await tempProject({ "computer.json": JSON.stringify({ desktop: "on" }) });
  assert.deepEqual(migrateGlobal(dir).length, 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["computer.json.migrated", "pi-improved.json"]);
  updateGlobal((c) => void delete c.computer, dir);
  assert.deepEqual(migrateGlobal(dir), []);
  assert.equal(readGlobal(dir).computer, undefined);
});

test("an old file left by an earlier migration is renamed once, with a short notice", async () => {
  const dir = await tempProject({ "pi-improved.json": JSON.stringify({ selfCompact: { default: { notice: "50%" } } }), "self-compact.json": JSON.stringify({ default: { notice: "70%" } }) });
  const notices = migrateGlobal(dir);
  assert.deepEqual(notices.length, 1);
  assert.match(notices[0], /^self-compact\.json is no longer read \(.*pi-improved\.json has selfCompact\): renamed it to self-compact\.json\.migrated\.$/);
  assert.equal(readGlobal(dir).selfCompact.default.notice, "50%");
  assert.deepEqual(migrateGlobal(dir), []);
});

test("pi's settings.json is never renamed: the notice says to remove the key", async () => {
  const dir = await tempProject({ "settings.json": JSON.stringify({ subagentPanes: "tern", theme: "dark" }) });
  assert.match(migrateGlobal(dir)[0], /Remove it from settings\.json: it is no longer read\./);
  await fs.access(path.join(dir, "settings.json"));
});

test("the project's .pi/self-compact.json is renamed after the move, and when workflow.json already has the key", async () => {
  const root = await tempProject({ ".pi/self-compact.json": JSON.stringify({ default: { force: "80%" } }) });
  assert.match(migrateProject(root)[0], /^Moved \.pi\/self-compact\.json into \.pi\/workflow\.json \(old file renamed to \.pi\/self-compact\.json\.migrated\)\.$/);
  assert.deepEqual((await fs.readdir(path.join(root, ".pi"))).sort(), ["self-compact.json.migrated", "workflow.json"]);
  await fs.writeFile(path.join(root, ".pi/self-compact.json"), "{}");
  assert.match(migrateProject(root)[0], /no longer read \(\.pi\/workflow\.json has selfCompact\)/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, MANIFEST_PATH), "utf8")).selfCompact.default.force, "80%");
});

test("an earlier .migrated backup is never overwritten", async () => {
  const dir = await tempProject({ "pi-improved.json": JSON.stringify({ computer: { desktop: "on" } }), "computer.json": JSON.stringify({ desktop: "off" }), "computer.json.migrated": "first" });
  assert.match(migrateGlobal(dir)[0], /renamed it to computer\.json\.migrated\.2\.$/);
  assert.equal(await fs.readFile(path.join(dir, "computer.json.migrated"), "utf8"), "first");
});
