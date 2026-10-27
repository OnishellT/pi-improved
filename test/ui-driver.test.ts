import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { discover } from "../src/discover.ts";
import { readManifest } from "../src/manifest.ts";
import { setupPrompt } from "../src/prompt.ts";
import { detectUiDrivers } from "../src/ui-driver.ts";
import { tempProject } from "./helpers.ts";

const noGit = async () => "";

async function binDir(files: Record<string, number>) {
  const dir = await tempProject({});
  for (const [name, mode] of Object.entries(files)) await fs.writeFile(path.join(dir, name), "#!/bin/sh\n", { mode });
  return dir;
}

const noAgent = () => tempProject({});
const agentWith = async (config: object) => tempProject({ "computer.json": JSON.stringify(config) });

test("detectUiDrivers finds an executable on PATH and ignores a non-executable file", async () => {
  const dir = await binDir({ "pi-desktop": 0o755 });
  const plain = await binDir({ "pi-desktop": 0o644 });
  const agent = await noAgent();
  assert.deepEqual(await detectUiDrivers(["/nonexistent", dir].join(path.delimiter), agent), ["pi-desktop"]);
  assert.deepEqual(await detectUiDrivers(plain, agent), []);
  assert.deepEqual(await detectUiDrivers("", agent), []);
});

test("the bundled desktop is offered only when /computer turned it on and its tools exist", { skip: process.platform !== "linux" }, async () => {
  const all = { hyprctl: 0o755, hypruse: 0o755, "dbus-run-session": 0o755, python3: 0o755 };
  const home = await noAgent();
  const on = await agentWith({ desktop: "on" });
  assert.deepEqual(await detectUiDrivers(await binDir(all), on, home), ["pi-desktop"]);
  assert.deepEqual(await detectUiDrivers(await binDir(all), await agentWith({ desktop: "off" }), home), []);
  assert.deepEqual(await detectUiDrivers(await binDir(all), await noAgent(), home), []);
  assert.deepEqual(await detectUiDrivers(await binDir({ hyprctl: 0o755 }), on, home), []);
  // Every tool but hypruse: it counts only when it exists somewhere, here the uv tool folder of the home.
  const { hypruse: _, ...noHypruse } = all;
  assert.deepEqual(await detectUiDrivers(await binDir(noHypruse), on, home), []);
  await fs.mkdir(path.join(home, ".local/bin"), { recursive: true });
  await fs.writeFile(path.join(home, ".local/bin/hypruse"), "", { mode: 0o755 });
  assert.deepEqual(await detectUiDrivers(await binDir(noHypruse), on, home), ["pi-desktop"]);
  // An mcp.json "desktop" entry wins, so /computer exports no $PI_DESKTOP: the bundled one must not be promised.
  const shadowed = await tempProject({ "computer.json": JSON.stringify({ desktop: "on" }), "mcp.json": JSON.stringify({ mcpServers: { desktop: { command: "x" } } }) });
  assert.deepEqual(await detectUiDrivers(await binDir(all), shadowed, home), []);
});

test("discover reports uiDrivers only when one is on PATH", async () => {
  const root = await tempProject({ "package.json": "{}" });
  assert.deepEqual((await discover(root, noGit, await binDir({ "pi-desktop": 0o755 }))).uiDrivers, ["pi-desktop"]);
  assert.equal("uiDrivers" in (await discover(root, noGit, "")), false);
});

test("the setup prompt offers the GUI driver in the verify-app step only when it was found", async () => {
  const root = await tempProject({});
  const manifest = await readManifest(root);
  const without = setupPrompt(await discover(root, noGit, ""), manifest, false);
  assert.doesNotMatch(without, /pi-desktop|hypruse/);
  const found = await discover(root, noGit, await binDir({ "pi-desktop": 0o755 }));
  const text = setupPrompt(found, manifest, false);
  const step = text.split("\n").find((l) => l.includes("verify-app/SKILL.md")) ?? "";
  assert.match(step, /these GUI drivers: `"\$\{PI_DESKTOP:-pi-desktop\}"` drives a private desktop/);
  assert.match(step, /`"\$\{PI_DESKTOP:-pi-desktop\}" VERB --help` lists the flags/);
  assert.match(step, /never as an absolute path/);
  assert.match(step, /SKIPPED: no GUI driver/);
  assert.match(step, /Never call bare `hypruse`/);
  assert.match(step, /Add its command to the verify list passed to `setup_finish` only if it runs green\.$/);
});
