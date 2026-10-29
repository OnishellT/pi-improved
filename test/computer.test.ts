import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { BROWSERS, browserStates, cdpServer, isolatedServer, planBrowser, stopIsolated } from "../src/computer/browsers.ts";
import { readComputerConfig, writeComputerConfig } from "../src/computer/config.ts";
import { desktopMissing, desktopWrapper } from "../src/computer/desktop.ts";
import { describeBrowser, registerComputer } from "../src/computer/index.ts";
import { fakePi, fakeUI, tempProject, withEnv } from "./helpers.ts";

const where = { home: "/home/u", platform: "linux" };
const ISOLATED = "Isolated: a private headless Chromium with its own profile, no approval";
const RELAY = "Relay: your own browser, with your logins (you approve remote debugging)";
const BOTH = "Both: the isolated one as `browser`, yours as `my-browser`";

/** A person with Brave installed, no tools on PATH, and an agent dir holding `config`. */
async function person(config?: object, mcpJson?: object) {
  const home = await tempProject({});
  await fs.mkdir(path.join(home, process.platform === "darwin" ? "Library/Application Support/BraveSoftware/Brave-Browser" : ".config/BraveSoftware/Brave-Browser"), { recursive: true });
  const agent = await tempProject({ ...(config ? { "pi-improved.json": JSON.stringify({ computer: config }) } : {}), ...(mcpJson ? { "mcp.json": JSON.stringify(mcpJson) } : {}) });
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

test("browser presets fail clearly on a platform without known folders", () => {
  const win = { home: "C:\\Users\\u", platform: "win32" };
  assert.throws(() => planBrowser("auto", win), /support Linux and macOS; use portFile or mcp/);
  assert.throws(() => planBrowser("chrome", win), /support Linux and macOS/);
  assert.deepEqual(browserStates(win, () => true), []);
  assert.equal(planBrowser({ portFile: "/x/DevToolsActivePort" }, win).kind, "cdp");
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
  assert.ok(config.timeout >= 90 + 3 * 20, "pi must not give up on a first open (approval, createTarget, attach, navigate) the server is still running");
});

test("config: missing file is empty, a non-object is a readable error, writes round-trip", async () => {
  const dir = await tempProject({});
  assert.deepEqual(await readComputerConfig(dir), {});
  await writeComputerConfig({ browser: "brave", desktop: "on" }, dir);
  assert.deepEqual(await readComputerConfig(dir), { browser: "brave", desktop: "on" });
  await fs.writeFile(path.join(dir, "pi-improved.json"), JSON.stringify({ computer: [1], mode: "flow" }));
  await assert.rejects(readComputerConfig(dir), /"computer" in .*pi-improved.json is not a JSON object/);
  // Saving keeps the rest of the global file.
  await fs.writeFile(path.join(dir, "pi-improved.json"), JSON.stringify({ mode: "flow" }));
  await writeComputerConfig({ desktop: "off" }, dir);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "pi-improved.json"), "utf8")), { mode: "flow", computer: { desktop: "off" } });
  await fs.writeFile(path.join(dir, "pi-improved.json"), "[1]");
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

test("a bad config registers nothing and tells the person once: in the UI, or on stderr without one", async () => {
  const p = await person({ browser: "netscape" });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(h.mcp, []);
    const notes: string[] = [];
    const ui = { notify: (m: string) => notes.push(m) };
    await h.emit("session_start", {}, { hasUI: true, ui });
    await h.emit("session_start", {}, { hasUI: true, ui });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Unknown browser "netscape".*\/computer/);

    const headless = fakePi();
    await registerComputer(headless.pi);
    const errors: string[] = [];
    const error = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      await headless.emit("session_start", {}, { hasUI: false, ui });
    } finally {
      console.error = error;
    }
    assert.equal(notes.length, 1);
    assert.match(errors.join("\n"), /^\[computer\] Unknown browser "netscape".*\/computer/);
  });
});

test("/computer picks a browser from what is installed, saves it and applies it without a restart", async () => {
  const p = await person();
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    const ui = fakeUI([RELAY, "Brave"]);
    const notes: string[] = [];
    await h.commands.get("computer").handler("", { ui: { ...ui, notify: (m: string) => notes.push(m) } });
    assert.match(ui.asked[0], /Browser the agent can drive \(now: off\)/);
    assert.equal(ui.asked.length, 2, "mode, then the browser; no desktop question without Hyprland tools");
    assert.deepEqual(await readComputerConfig(p.agent), { browser: { mode: "relay", relay: "brave" } });
    assert.deepEqual(targetsOf(server(h, "browser")).map((t: any) => t.id), ["brave"]);
    assert.match(notes[0], /Browser: relay \(relay: brave\)\. Desktop: off\./);
    assert.match(notes[0], /approve remote debugging/);
    assert.match(notes[0], /Desktop is not offered here: it needs .*hyprctl/);

    await h.commands.get("computer").handler("", { ui: fakeUI(["Off"]) });
    assert.equal(server(h, "browser"), undefined);
    assert.deepEqual(await readComputerConfig(p.agent), { browser: "off" });
  });
});

test("the isolated browser outlives its session: only turning it off in /computer stops it", async () => {
  const p = await person({ browser: { mode: "isolated" } });
  const profile = path.join(p.agent, "browser-profile");
  await fs.mkdir(profile, { recursive: true });
  // Stands in for the detached Chromium: a live process whose command line names the profile.
  const child = spawn(process.execPath, ["-e", "console.log('up'); setTimeout(() => {}, 60000)", "--", `--user-data-dir=${profile}`], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout, "data"); // past exec: before it, the command line is still the parent's
  await fs.symlink(`host-${child.pid}`, path.join(profile, "SingletonLock"));
  try {
    await withEnv(p.env, async () => {
      const h = fakePi();
      await registerComputer(h.pi);
      const notes: string[] = [];
      await h.commands.get("computer").handler("", { ui: { ...fakeUI(["No changes"]), notify: (m: string) => notes.push(m) } });
      assert.equal(child.exitCode, null, "unchanged config leaves the browser running");
      await h.commands.get("computer").handler("", { ui: { ...fakeUI(["Off"]), notify: (m: string) => notes.push(m) } });
      await once(child, "exit");
      assert.match(notes.at(-1)!, /isolated browser was stopped/);
    });
  } finally {
    child.kill();
  }
});

test("stopIsolated kills only a process that is still that profile's browser", async () => {
  const profile = path.join(await tempProject({}), "browser-profile");
  await fs.mkdir(profile, { recursive: true });
  const killed: number[] = [];
  const stop = (command: string) => stopIsolated(profile, async () => command, (pid) => void killed.push(pid));
  assert.equal(await stop("whatever"), false, "no SingletonLock: nothing to stop");
  await fs.symlink("host-4242", path.join(profile, "SingletonLock"));
  assert.equal(await stop("vim notes.txt"), false, "a pid reused by another program");
  assert.equal(await stop(`chrome --user-data-dir=${profile} about:blank`), true);
  assert.deepEqual(killed, [4242]);
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
    // /reload runs the extension again in the same process: the new copy must not take our export for the person's.
    await h.commands.get("computer").handler("", { ui: fakeUI(["No changes", "On"]) });
    const reloaded = fakePi();
    await registerComputer(reloaded.pi);
    await reloaded.commands.get("computer").handler("", { ui: fakeUI(["No changes", "Off"]) });
    assert.equal(process.env.PI_DESKTOP, "mine", "the person's value survives a reload");
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

test("a desktop value that is neither on nor off is reported", async () => {
  const p = await person({ desktop: "yes" as any });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.equal(server(h, "desktop"), undefined);
    const notes: string[] = [];
    await h.emit("session_start", {}, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /desktop must be "on" or "off", not "yes"/);
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
    await assert.rejects(fs.access(path.join(p.agent, "pi-improved.json")));
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

test("planBrowser: modes, and the old values keep meaning relay", () => {
  assert.deepEqual(planBrowser({ mode: "isolated" }, where), { kind: "isolated" });
  assert.equal((planBrowser({ mode: "relay" }, where) as any).targets.length, BROWSERS.length, "relay defaults to auto");
  assert.deepEqual((planBrowser({ mode: "relay", relay: "brave" }, where) as any).targets.map((t: any) => t.id), ["brave"]);
  const both: any = planBrowser({ mode: "both", relay: { portFile: "/x/DevToolsActivePort", name: "Mine" } }, where);
  assert.equal(both.kind, "both");
  assert.deepEqual(both.targets, [{ id: "custom", name: "Mine", portFile: "/x/DevToolsActivePort" }]);
  assert.deepEqual(planBrowser("brave", where), planBrowser({ mode: "relay", relay: "brave" }, where));
  assert.deepEqual(planBrowser("auto", where), planBrowser({ mode: "relay", relay: "auto" }, where));
  assert.deepEqual(planBrowser({ portFile: "/x/DevToolsActivePort" }, where), planBrowser({ mode: "relay", relay: { portFile: "/x/DevToolsActivePort" } }, where));
  assert.throws(() => planBrowser({ mode: "sideways" } as any, where), /browser\.mode must be "isolated", "relay", "both"/);
  assert.throws(() => planBrowser({ mode: "both", relay: "netscape" }, where), /Unknown browser "netscape"/);
  assert.equal(planBrowser({ mode: "isolated" }, { home: "C:\\u", platform: "win32" }).kind, "isolated");
});

test("isolatedServer launches its own headless Chromium with a persistent profile; no approval", () => {
  const config: any = isolatedServer("/agent/browser-profile");
  const [target] = targetsOf(config);
  assert.deepEqual(target.launch, { profile: "/agent/browser-profile" });
  assert.equal(target.portFile, "/agent/browser-profile/DevToolsActivePort");
  assert.match(config.description, /headless Chromium.*persistent profile.*no approval/);
  assert.match((cdpServer([{ id: "b", name: "Brave", portFile: "/p" }], true) as any).description, /only when the task needs the user's logged-in sessions or the user asks for their browser/);
  assert.doesNotMatch((cdpServer([{ id: "b", name: "Brave", portFile: "/p" }]) as any).description, /only when the task needs/);
});

test("mode both registers `browser` (isolated) and `my-browser` (relay); switching mode removes what no longer applies", async () => {
  const p = await person({ browser: { mode: "both", relay: "brave" } });
  await withEnv(p.env, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.ok(targetsOf(server(h, "browser"))[0].launch);
    assert.deepEqual(targetsOf(server(h, "my-browser")).map((t: any) => t.id), ["brave"]);
    assert.match(server(h, "my-browser").description, /only when the task needs the user's logged-in sessions/);

    await h.commands.get("computer").handler("", { ui: fakeUI([ISOLATED]) });
    assert.deepEqual(await readComputerConfig(p.agent), { browser: { mode: "isolated" } });
    assert.ok(server(h, "browser"));
    assert.equal(server(h, "my-browser"), undefined);

    await h.commands.get("computer").handler("", { ui: fakeUI([BOTH, "Auto: the first browser with remote debugging on"]) });
    assert.deepEqual(await readComputerConfig(p.agent), { browser: { mode: "both", relay: "auto" } });
    assert.equal(targetsOf(server(h, "my-browser")).length, BROWSERS.length);

    await h.commands.get("computer").handler("", { ui: fakeUI(["Off"]) });
    assert.equal(server(h, "browser"), undefined);
    assert.equal(server(h, "my-browser"), undefined);
  });
});

test("old config values register as relay under the name `browser`", async () => {
  for (const browser of ["brave", "auto", { portFile: "/x/DevToolsActivePort" }]) {
    const p = await person({ browser });
    await withEnv(p.env, async () => {
      const h = fakePi();
      await registerComputer(h.pi);
      assert.equal(targetsOf(server(h, "browser"))[0].launch, undefined);
      assert.equal(server(h, "my-browser"), undefined);
    });
  }
});

test("describeBrowser names the mode", () => {
  assert.equal(describeBrowser({ mode: "isolated" }), "isolated");
  assert.equal(describeBrowser({ mode: "both", relay: "brave" }), "both (relay: brave)");
  assert.equal(describeBrowser({ mode: "relay" }), "relay (relay: auto)");
});
