import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocketServer } from "ws";
import { cdpServer } from "../src/computer/browsers.ts";
import { OwnedBrowser, allowedUrl, buildServer, endpoint, parseTargets, servesProfile } from "../src/computer/cdp-server.mjs";
import { tempDir, withEnv } from "./helpers.ts";

const value = (result: any) => JSON.parse(result.content[0].text);

async function scratch() {
  return tempDir("pi-browser-");
}

async function portFile(dir: string, name: string, contents?: string) {
  const file = path.join(dir, name);
  if (contents !== undefined) await fs.writeFile(file, contents, { mode: 0o600 });
  return file;
}

/** The server in this process (a spawned one costs about 2 s): the config test below covers the real stdio transport. */
async function client(targets: object[], subagent = false) {
  const server = await withEnv({ PI_SUBAGENT_RUN_DIR: subagent ? "/test/read-only" : undefined }, async () => buildServer(new OwnedBrowser(parseTargets(JSON.stringify(targets)))));
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await server.connect(theirs);
  const result = new Client({ name: "browser-check", version: "1.0.0" });
  await result.connect(ours);
  return result;
}

/** Waits up to 2 s for `check`, so a loaded machine does not fail a test that a fixed sleep would. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (const deadline = Date.now() + 2000; !(await check()); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
  }
}

/** A CDP endpoint that answers like a browser: records every call, hands out one owned target. */
async function fakeChrome(calls: any[], hold?: Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", async (data) => {
      const call = JSON.parse(String(data));
      calls.push(call);
      if (call.method === "Target.createTarget") await hold; // a slow window: the server may exit meanwhile
      let result: any = {};
      if (call.method === "Target.createTarget") result = { targetId: "owned" };
      else if (call.method === "Target.attachToTarget") result = { sessionId: "owned-session" };
      else if (call.method === "Target.closeTarget") result = { success: true };
      else if (call.method === "Runtime.evaluate") {
        result = call.params.expression.includes("#missing")
          ? { exceptionDetails: { text: "Selector must match exactly one control" } }
          : { result: { value: call.params.expression.includes("getBoundingClientRect") ? { x: 20, y: 30 } : call.params.expression.includes("#big") ? "x".repeat(12001) : { ok: true } } };
      }
      socket.send(JSON.stringify({ method: "Ignored.event", params: {} }));
      socket.send(JSON.stringify({ id: call.id, result }));
    }),
  );
  return server;
}

const stop = async (server: WebSocketServer) => {
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
};

/** A port nothing listens on: what a crashed browser leaves behind in DevToolsActivePort. */
async function deadPort() {
  const server = await fakeChrome([]);
  const { port } = server.address() as any;
  await stop(server);
  return port as number;
}

test("endpoint stays on loopback and rejects malformed paths and ports", () => {
  assert.equal(endpoint("9222\n/devtools/browser\n"), "ws://127.0.0.1:9222/devtools/browser");
  assert.equal(endpoint("1234\n/devtools/browser/abc-123"), "ws://127.0.0.1:1234/devtools/browser/abc-123");
  for (const input of ["", "0\n/devtools/browser", "65536\n/devtools/browser", "host\n/devtools/browser", "123\n//evil.example", "123\n/devtools/browser?token=x", "123\n/devtools/page/personal"]) {
    assert.throws(() => endpoint(input));
  }
});

test("navigation does not permit internal pages, files, script URLs or URL credentials", () => {
  assert.equal(allowedUrl("about:blank"), "about:blank");
  assert.equal(allowedUrl("https://example.com"), "https://example.com/");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "https://user:secret@example.com"]) {
    assert.throws(() => allowedUrl(url));
  }
});

test("parseTargets needs a non-empty list of absolute port files", () => {
  assert.deepEqual(parseTargets('[{"id":"a","name":"A","portFile":"/p"}]'), [{ id: "a", name: "A", portFile: "/p" }]);
  assert.deepEqual(parseTargets('[{"portFile":"/p"}]'), [{ id: "/p", name: "browser", portFile: "/p" }]);
  for (const bad of ["", "{}", "[]", '[{"portFile":"relative"}]', "[1]"]) assert.throws(() => parseTargets(bad), bad);
});

test("open fails closed without a consent endpoint; subagents have status only", async () => {
  const dir = await scratch();
  const targets = [{ id: "helium", name: "Helium", portFile: await portFile(dir, "a") }, { id: "brave", name: "Brave", portFile: await portFile(dir, "b") }];
  let main, sub;
  try {
    main = await client(targets);
    const status = value(await main.callTool({ name: "status", arguments: {} }));
    assert.equal(status.enabled, false);
    assert.deepEqual(status.targets, ["Helium", "Brave"]);
    assert.match(status.action, /in Helium or Brave, then approve open/);
    const denied: any = await main.callTool({ name: "open", arguments: { url: "about:blank" } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /In Helium or Brave enable chrome:\/\/inspect.*approve/);
    sub = await client(targets, true);
    assert.deepEqual((await sub.listTools()).tools.map((t) => t.name), ["status"]);
  } finally {
    await main?.close();
    await sub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("status lists the browsers with a debugging file and names the connected one only once connected", async () => {
  const dir = await scratch();
  const targets = [
    { id: "helium", name: "Helium", portFile: await portFile(dir, "none") },
    { id: "brave", name: "Brave", portFile: await portFile(dir, "brave", "9\n/devtools/browser\n") },
    { id: "chrome", name: "Chrome", portFile: await portFile(dir, "chrome", "9\n/devtools/browser\n") },
  ];
  let main;
  try {
    main = await client(targets);
    const status = value(await main.callTool({ name: "status", arguments: {} }));
    assert.equal(status.enabled, true);
    assert.deepEqual(status.available, ["Brave", "Chrome"]);
    assert.equal(status.browser, undefined);
    assert.equal(status.connected, false);
  } finally {
    await main?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a malformed debugging file is an error, not a silent fallback to another browser", async () => {
  const dir = await scratch();
  const targets = [
    { id: "a", name: "A", portFile: await portFile(dir, "a", "garbage") },
    { id: "b", name: "B", portFile: await portFile(dir, "b", "9\n/devtools/browser\n") },
  ];
  let main;
  try {
    main = await client(targets);
    const status: any = await main.callTool({ name: "status", arguments: {} });
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /^A: Invalid local browser endpoint/);
  } finally {
    await main?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native WebSocket and MCP route every page command to the created target, never personal tabs", async () => {
  const dir = await scratch();
  const calls: any[] = [];
  const server = await fakeChrome(calls);
  let main;
  try {
    const file = await portFile(dir, "DevToolsActivePort", `${(server.address() as any).port}\n/devtools/browser\n`);
    main = await client([{ id: "brave", name: "Brave", portFile: file }]);
    const opened = value(await main.callTool({ name: "open", arguments: { url: "https://example.com/" } }));
    assert.equal(opened.ownedTarget, "owned");
    assert.equal(opened.browser, "Brave");
    assert.deepEqual(value(await main.callTool({ name: "evaluate", arguments: { expression: "({ok:true})" } })), { ok: true });
    const before = calls.filter((c) => c.method.startsWith("Input.")).length;
    assert.equal(((await main.callTool({ name: "click", arguments: { selector: "#missing" } })) as any).isError, true);
    assert.equal(calls.filter((c) => c.method.startsWith("Input.")).length, before);
    assert.equal(((await main.callTool({ name: "click", arguments: { selector: "#save" } })) as any).isError, undefined);
    assert.equal(value(await main.callTool({ name: "close", arguments: {} })).closed, true);
    assert.equal(((await main.callTool({ name: "evaluate", arguments: { expression: "1" } })) as any).isError, true);
    assert.deepEqual(calls.filter((c) => !c.sessionId).map((c) => c.method), ["Target.createTarget", "Target.attachToTarget", "Target.closeTarget"]);
    assert.deepEqual(calls[0].params, { url: "about:blank", newWindow: true, background: true });
    assert.ok(calls.filter((c) => c.sessionId).every((c) => c.sessionId === "owned-session"));
    assert.equal(calls.find((c) => c.method === "Target.closeTarget").params.targetId, "owned");
    assert.ok(!calls.some((c) => /getTargets|Discover|AutoAttach|Browser.close|Cookie/.test(c.method)));
    assert.equal(value(await main.callTool({ name: "open", arguments: {} })).ownedTarget, "owned");
    await main.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.filter((c) => c.method === "Target.closeTarget").length, 1, "the relay window stays open when the server exits");
  } finally {
    await main?.close();
    await stop(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function opened(run: (main: any, calls: any[], server: WebSocketServer) => Promise<void>) {
  const dir = await scratch();
  const calls: any[] = [];
  const server = await fakeChrome(calls);
  let main;
  try {
    const file = await portFile(dir, "DevToolsActivePort", `${(server.address() as any).port}\n/devtools/browser\n`);
    main = await client([{ id: "brave", name: "Brave", portFile: file }]);
    await main.callTool({ name: "open", arguments: { url: "about:blank" } });
    await run(main, calls, server);
  } finally {
    await main?.close();
    await stop(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("evaluate refuses a result over the size cap", async () => {
  await opened(async (main) => {
    const big: any = await main.callTool({ name: "evaluate", arguments: { expression: "'#big'" } });
    assert.equal(big.isError, true);
    assert.match(big.content[0].text, /Result too large/);
  });
});

test("open after close creates a new window", async () => {
  await opened(async (main, calls) => {
    assert.equal(value(await main.callTool({ name: "close", arguments: {} })).closed, true);
    assert.equal(value(await main.callTool({ name: "open", arguments: {} })).ownedTarget, "owned");
    assert.equal(calls.filter((c) => c.method === "Target.createTarget").length, 2);
  });
});

test("a window the person closed by hand is forgotten: the next open makes a new one", async () => {
  await opened(async (main, calls, server) => {
    for (const socket of server.clients) socket.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "owned-session", targetId: "owned" } }));
    await until(async () => value(await main.callTool({ name: "status", arguments: {} })).ownedWindow === false, "the window to be forgotten");
    assert.equal(value(await main.callTool({ name: "open", arguments: {} })).ownedTarget, "owned");
    assert.equal(calls.filter((c) => c.method === "Target.createTarget").length, 2);
    assert.equal(calls.filter((c) => c.method === "Target.attachToTarget").length, 2);
  });
});

test("the config the extension registers starts a working server", async () => {
  const dir = await scratch();
  const config: any = cdpServer([{ id: "brave", name: "Brave", portFile: await portFile(dir, "none") }]);
  const transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: "pipe" });
  const result = new Client({ name: "config-check", version: "1.0.0" });
  try {
    await result.connect(transport);
    assert.deepEqual((await result.listTools()).tools.map((t) => t.name).sort(), ["click", "close", "evaluate", "open", "snapshot", "status"]);
    assert.equal(value(await result.callTool({ name: "status", arguments: {} })).enabled, false);
  } finally {
    await result.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auto skips a stale endpoint left by a browser that is gone and uses the next one", async () => {
  const dir = await scratch();
  const calls: any[] = [];
  const server = await fakeChrome(calls);
  const targets = [
    { id: "helium", name: "Helium", portFile: await portFile(dir, "stale", `${await deadPort()}\n/devtools/browser\n`) },
    { id: "brave", name: "Brave", portFile: await portFile(dir, "live", `${(server.address() as any).port}\n/devtools/browser\n`) },
  ];
  let main;
  try {
    main = await client(targets);
    assert.equal(value(await main.callTool({ name: "open", arguments: { url: "about:blank" } })).browser, "Brave");
    assert.equal(calls[0].method, "Target.createTarget");
  } finally {
    await main?.close();
    await stop(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failed first connection does not wedge the server: the next open tries again", async () => {
  const dir = await scratch();
  const calls: any[] = [];
  const server = await fakeChrome(calls);
  const file = await portFile(dir, "DevToolsActivePort", `${await deadPort()}\n/devtools/browser\n`);
  let main;
  try {
    main = await client([{ id: "brave", name: "Brave", portFile: file }]);
    const refused: any = await main.callTool({ name: "open", arguments: { url: "about:blank" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Brave left a debugging file but is not running/);
    await fs.writeFile(file, `${(server.address() as any).port}\n/devtools/browser\n`);
    assert.equal(value(await main.callTool({ name: "open", arguments: { url: "about:blank" } })).ownedTarget, "owned");
  } finally {
    await main?.close();
    await stop(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a browser that listens but rejects the connection is the answer: no second approval prompt elsewhere", async () => {
  const dir = await scratch();
  const calls: any[] = [];
  const live = await fakeChrome(calls);
  const denied = http.createServer();
  let handshakes = 0;
  denied.on("upgrade", (_req, socket) => {
    handshakes++;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve));
  const targets = [
    { id: "helium", name: "Helium", portFile: await portFile(dir, "denied", `${(denied.address() as any).port}\n/devtools/browser\n`) },
    { id: "brave", name: "Brave", portFile: await portFile(dir, "live", `${(live.address() as any).port}\n/devtools/browser\n`) },
  ];
  let main;
  try {
    main = await client(targets);
    const result: any = await main.callTool({ name: "open", arguments: { url: "about:blank" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Helium/);
    assert.deepEqual(calls, [], "Brave must not be contacted");
    // Fail closed like the original server: no new approval prompt on every later call.
    const again: any = await main.callTool({ name: "open", arguments: { url: "about:blank" } });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /Helium disconnected; no automatic retry/);
    assert.equal(handshakes, 1);
  } finally {
    await main?.close();
    await stop(live);
    await new Promise((resolve) => denied.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the isolated browser starts again after it dies, and its window closes when the server exits", async () => {
  const dir = await scratch();
  const profile = path.join(dir, "profile");
  const file = path.join(profile, "DevToolsActivePort");
  const calls: any[] = [];
  const serve = async () => {
    const chrome = await fakeChrome(calls);
    await fs.writeFile(file, `${(chrome.address() as any).port}\n/devtools/browser\n`);
    return chrome;
  };
  await fs.mkdir(profile);
  let chrome = await serve();
  let main: any;
  try {
    // A browser already listens on the profile's port file, so launch starts nothing (no Nix needed).
    main = await client([{ id: "isolated", name: "Headless Chromium", portFile: file, launch: { profile } }]);
    assert.equal(value(await main.callTool({ name: "open", arguments: {} })).ownedTarget, "owned");
    await stop(chrome); // it crashed
    await until(async () => value(await main.callTool({ name: "status", arguments: {} })).connected === false, "the dead browser to disconnect");
    chrome = await serve();
    assert.equal(value(await main.callTool({ name: "open", arguments: {} })).ownedTarget, "owned", "no 'Reconnect the MCP server'");
    assert.equal(calls.filter((c) => c.method === "Target.createTarget").length, 2);
    await main.close();
    await until(() => calls.some((c) => c.method === "Target.closeTarget" && c.params.targetId === "owned"), "the window to close on exit");
  } finally {
    await main?.close();
    await stop(chrome);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an isolated window still being created when the server exits is closed too", async () => {
  const dir = await scratch();
  const profile = path.join(dir, "profile");
  const file = path.join(profile, "DevToolsActivePort");
  const calls: any[] = [];
  let release!: () => void;
  const chrome = await fakeChrome(calls, new Promise((resolve) => (release = resolve)));
  await fs.mkdir(profile);
  await fs.writeFile(file, `${(chrome.address() as any).port}\n/devtools/browser\n`);
  try {
    const main = await client([{ id: "isolated", name: "Headless Chromium", portFile: file, launch: { profile } }]);
    const opening = main.callTool({ name: "open", arguments: {} }).catch(() => {});
    await until(() => calls.some((c) => c.method === "Target.createTarget"), "the window to be requested");
    await main.close();
    release();
    await opening;
    await until(() => calls.some((c) => c.method === "Target.closeTarget" && c.params.targetId === "owned"), "the window to close on exit");
  } finally {
    await stop(chrome);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a start that gives up kills its child only while that child does not serve the profile", async () => {
  const profile = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "serves-"));
  const portFile = path.join(profile, "DevToolsActivePort");
  try {
    assert.equal(await servesProfile(profile, portFile, 4242), false, "no lock, no port file");
    await fs.symlink("host-4242", path.join(profile, "SingletonLock"));
    assert.equal(await servesProfile(profile, portFile, 4242), false, "owner without a port file: nobody can be using it");
    await fs.writeFile(portFile, "9222\n/devtools/browser/x\n");
    assert.equal(await servesProfile(profile, portFile, 4242), true, "another session may use it: keep it");
    assert.equal(await servesProfile(profile, portFile, 4243), false, "a child that handed off or lost: its own to kill");
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("launch starts nothing when the profile's browser already listens, and keeps the profile private", async () => {
  const dir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "launch-"));
  const profile = path.join(dir, "profile");
  const server = (await import("node:net")).createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, "DevToolsActivePort"), `${(server.address() as any).port}\n/devtools/browser/x\n`);
    // Would need Nix to start anything: resolving means it used the running browser, the same one for concurrent starters.
    const target = { id: "i", name: "Headless Chromium", portFile: path.join(profile, "DevToolsActivePort"), launch: { profile } };
    await Promise.all([new OwnedBrowser([target]).launch(target), new OwnedBrowser([target]).launch(target)]);
    assert.equal((await fs.stat(profile)).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readdir(profile), ["DevToolsActivePort"], "no lock or pid file of ours");
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
