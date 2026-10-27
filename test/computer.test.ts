import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { BROWSERS, browserStates, cdpServer, planBrowser } from "../src/computer/browsers.ts";
import { readComputerConfig, writeComputerConfig } from "../src/computer/config.ts";
import { desktopMissing, desktopWrapper } from "../src/computer/desktop.ts";
import { describeBrowser, registerComputer } from "../src/computer/index.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const where = { home: "/home/u", platform: "linux" };

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

/** A person with Brave installed, no tools on PATH, and an agent dir holding `config`. */
async function person(config?: object, mcpJson?: object) {
  const home = await tempProject({});
  await fs.mkdir(path.join(home, process.platform === "darwin" ? "Library/Application Support/BraveSoftware/Brave-Browser" : ".config/BraveSoftware/Brave-Browser"), { recursive: true });
  const agent = await tempProject({ ...(config ? { "computer.json": JSON.stringify(config) } : {}), ...(mcpJson ? { "mcp.json": JSON.stringify(mcpJson) } : {}) });
  const bin = await tempProject({});
  // PI_DESKTOP is the person's own value: the extension must hand it back, and withEnv restores it after the test.
  return { env: { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: bin, PI_DESKTOP: "mine" }, home, agent, bin };
}

const server = (h: ReturnType<typeof fakePi>, name: string) => h.mcp.find((m) => m.name === name)?.config;
const targetsOf = (config: any) => JSON.parse(config.args[1]);

test("planBrowser: off by default, auto lists every preset, a preset pins one, bad values explain themselves", () => {
  assert.deepEqual(planBrowser(undefined, where), { kind: "off" });
  assert.deepEqual(planBrowser("off", where), { kind: "off" });
  const auto: any = planBrowser("auto", where);
  assert.deepEqual(auto.targets.map((t: any) => t.id), BROWSERS.map((b) => b.id));
  assert.equal(auto.targets[0].portFile, "/home/u/.config/net.imput.helium/DevToolsActivePort");
  assert.equal((planBrowser("brave", where) as any).targets[0].portFile, "/home/u/.config/BraveSoftware/Brave-Browser/DevToolsActivePort");
  assert.equal((planBrowser("chrome", { home: "/Users/u", platform: "darwin" }) as any).targets[0].portFile, "/Users/u/Library/Application Support/Google/Chrome/DevToolsActivePort");
  assert.deepEqual((planBrowser({ portFile: "/x/DevToolsActivePort", name: "Mine" }, where) as any).targets, [{ id: "custom", name: "Mine", portFile: "/x/DevToolsActivePort" }]);
  assert.throws(() => planBrowser("netscape", where), /Unknown browser "netscape"\. Use off, auto, helium, chrome/);
  assert.throws(() => planBrowser({ portFile: "relative/DevToolsActivePort" }, where), /browser needs/);
  assert.throws(() => planBrowser({ mcp: {} as any }, where), /"command" or a "url"/);
  assert.deepEqual(planBrowser({ mcp: { command: "npx", args: ["@playwright/mcp"] } }, where), { kind: "mcp", config: { exposure: "codemode", command: "npx", args: ["@playwright/mcp"] } });
});

test("browserStates separates installed from remote debugging on", () => {
  const on = new Set(["/home/u/.config/chromium", "/home/u/.config/chromium/DevToolsActivePort", "/home/u/.config/vivaldi"]);
  const states = browserStates(where, (f) => on.has(f));
  assert.deepEqual(states.filter((s) => s.installed).map((s) => [s.id, s.debugging]), [["chromium", true], ["vivaldi", false]]);
});

test("cdpServer hands the bundled server its targets as the only argument", () => {
  const config: any = cdpServer([{ id: "brave", name: "Brave", portFile: "/p" }]);
  assert.match(config.args[0], /computer\/cdp-server\.mjs$/);
  assert.deepEqual(targetsOf(config), [{ id: "brave", name: "Brave", portFile: "/p" }]);
  assert.match(config.description, /Brave/);
});

test("config: missing file is empty, a non-object is a readable error, writes round-trip", async () => {
  const dir = await tempProject({});
  assert.deepEqual(await readComputerConfig(dir), {});
  await writeComputerConfig({ browser: "brave", desktop: "on" }, dir);
  assert.deepEqual(await readComputerConfig(dir), { browser: "brave", desktop: "on" });
  await fs.writeFile(path.join(dir, "computer.json"), "[1]");
  await assert.rejects(readComputerConfig(dir), /is not a JSON object/);
});

test("desktopMissing names what is absent", { skip: process.platform !== "linux" }, async () => {
  const empty = await tempProject({});
  const home = await tempProject({});
  assert.deepEqual(desktopMissing(empty, home), ["hyprctl (Hyprland)", "hypruse (uv tool install hypruse)", "dbus-run-session (dbus)", "python3"]);
  // The wrapper needs the uv copy to be executable: a plain file does not count.
  await fs.mkdir(path.join(home, ".local/bin"), { recursive: true });
  await fs.writeFile(path.join(home, ".local/bin/hypruse"), "", { mode: 0o644 });
  assert.ok(desktopMissing(empty, home).includes("hypruse (uv tool install hypruse)"));
  const tools = await tempProject({});
  for (const name of ["hyprctl", "hypruse", "dbus-run-session", "python3"]) await fs.writeFile(path.join(tools, name), "", { mode: 0o755 });
  assert.deepEqual(desktopMissing(tools, home), []);
});

test("nothing is registered until the person chooses", async () => {
  const p = await person();
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(h.mcp, []);
    assert.ok(h.commands.has("computer"));
    assert.equal(process.env.PI_DESKTOP, "mine", "a value the person set is not touched until we export our own");
  });
});

test("a configured browser is registered at load; auto may attach to any preset", async () => {
  for (const [browser, count] of [["brave", 1], ["auto", BROWSERS.length]] as const) {
    const p = await person({ browser });
    await withEnv(p.env, async () => {
      const h = fakePi();
      await registerComputer(h.pi);
      assert.equal(targetsOf(server(h, "browser")).length, count);
      assert.equal(server(h, "desktop"), undefined);
    });
  }
});

test("a custom MCP server is registered under the browser name as given", async () => {
  const p = await person({ browser: { mcp: { command: "npx", args: ["@playwright/mcp@latest"] } } });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(server(h, "browser"), { exposure: "codemode", command: "npx", args: ["@playwright/mcp@latest"] });
  });
});

test("a bad config registers nothing and tells the person once, with a UI", async () => {
  const p = await person({ browser: "netscape" });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(h.mcp, []);
    const notes: string[] = [];
    const ui = { notify: (m: string) => notes.push(m) };
    await h.emit("session_start", {}, { hasUI: false, ui });
    assert.deepEqual(notes, []);
    await h.emit("session_start", {}, { hasUI: true, ui });
    await h.emit("session_start", {}, { hasUI: true, ui });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Unknown browser "netscape".*\/computer/);
  });
});

test("/computer picks a browser from what is installed, saves it and applies it without a restart", async () => {
  const p = await person();
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    const ui = fakeUI(["Brave"]);
    const notes: string[] = [];
    await h.commands.get("computer").handler("", { ui: { ...ui, notify: (m: string) => notes.push(m) } });
    assert.match(ui.asked[0], /Browser the agent can drive \(now: off\)/);
    assert.equal(ui.asked.length, 1, "no desktop question without Hyprland tools");
    assert.deepEqual(await readComputerConfig(p.agent), { browser: "brave" });
    assert.deepEqual(targetsOf(server(h, "browser")).map((t: any) => t.id), ["brave"]);
    assert.match(notes[0], /Browser: brave\. Desktop: off\./);
    assert.match(notes[0], /approve remote debugging/);
    assert.match(notes[0], /Desktop is not offered here: it needs .*hyprctl/);

    await h.commands.get("computer").handler("", { ui: fakeUI(["Off"]) });
    assert.equal(server(h, "browser"), undefined);
    assert.deepEqual(await readComputerConfig(p.agent), { browser: "off" });
  });
});

test("/computer keeps what it is not asked to change, including a custom entry", async () => {
  const custom = { mcp: { command: "npx", args: ["x"] } };
  const p = await person({ browser: custom, extra: 1 });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    await h.commands.get("computer").handler("", { ui: fakeUI(["No changes"]) });
    assert.deepEqual(await readComputerConfig(p.agent), { browser: custom, extra: 1 } as any);
    assert.ok(server(h, "browser"));
  });
});

test("/computer turns the private desktop on and off when its tools exist", { skip: process.platform !== "linux" }, async () => {
  const p = await person();
  for (const name of ["hyprctl", "hypruse", "dbus-run-session", "python3"]) await fs.writeFile(path.join(p.bin, name), "", { mode: 0o755 });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    const ui = fakeUI(["No changes", "On"]);
    await h.commands.get("computer").handler("", { ui });
    assert.match(ui.asked[1], /Desktop: a private Hyprland session/);
    assert.equal((server(h, "desktop") as any).command, desktopWrapper());
    assert.equal(process.env.PI_DESKTOP, desktopWrapper(), "shell steps and scripts get it by name, not by a path baked into a committed script");
    assert.deepEqual(await readComputerConfig(p.agent), { desktop: "on" });
    await h.commands.get("computer").handler("", { ui: fakeUI(["No changes", "Off"]) });
    assert.equal(server(h, "desktop"), undefined);
    assert.equal(process.env.PI_DESKTOP, "mine", "withdrawing the desktop gives the person's value back");
  });
});

test("desktop on without its tools registers nothing and says what is missing", { skip: process.platform !== "linux" }, async () => {
  const p = await person({ desktop: "on" });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.equal(server(h, "desktop"), undefined);
    const notes: string[] = [];
    await h.emit("session_start", {}, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /Desktop is on but needs: hyprctl \(Hyprland\), hypruse/);
  });
});

test("/computer repairs a config whose browser value is not a string or an object", async () => {
  for (const bad of [null, 5, true]) {
    const p = await person({ browser: bad });
    await withEnv(p.env, async () => {
      const h = fakePi();
      await registerComputer(h.pi);
      assert.deepEqual(h.mcp, []);
      const ui = fakeUI(["Off"]);
      await h.commands.get("computer").handler("", { ui });
      assert.match(ui.asked[0], /now: invalid/);
      assert.deepEqual(await readComputerConfig(p.agent), { browser: "off" });
    });
  }
});

test("cancelling every question changes nothing and writes nothing", async () => {
  const p = await person();
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    await h.commands.get("computer").handler("", { ui: fakeUI([undefined]) });
    assert.deepEqual(await readComputerConfig(p.agent), {});
    await assert.rejects(fs.access(path.join(p.agent, "computer.json")));
    assert.deepEqual(h.mcp, []);
  });
});

test("an mcp.json entry of the same name wins: nothing is registered or exported, and the person is told", { skip: process.platform !== "linux" }, async () => {
  const p = await person({ browser: "brave", desktop: "on" }, { mcpServers: { browser: { command: "x" }, desktop: { command: "y" } } });
  for (const name of ["hyprctl", "hypruse", "dbus-run-session", "python3"]) await fs.writeFile(path.join(p.bin, name), "", { mode: 0o755 });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(h.mcp, []);
    assert.equal(process.env.PI_DESKTOP, "mine");
    const notes: string[] = [];
    await h.emit("session_start", {}, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /mcp\.json already defines "browser".*mcp\.json already defines "desktop"/);
  });
});

test("describeBrowser never throws and flags what it cannot read", () => {
  for (const [value, text] of [[undefined, "off"], ["brave", "brave"], [null, "invalid"], [5, "invalid"], [[], "invalid"], [{}, "invalid"], [{ portFile: "/p" }, "custom (/p)"], [{ portFile: "/p", name: "Mine" }, "custom (Mine)"], [{ mcp: {} }, "custom MCP server"]] as const) {
    assert.equal(describeBrowser(value), text);
  }
});

test("a disabled mcp.json entry still wins, so it still counts as a conflict", async () => {
  const p = await person({ browser: "brave" }, { mcpServers: { browser: { command: "x", enabled: false } } });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(h.mcp, []);
    const notes: string[] = [];
    await h.emit("session_start", {}, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /mcp\.json already defines "browser"/);
  });
});
