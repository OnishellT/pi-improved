import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Image, resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { findBrowser, pageFor, pruneRenders, registerShow, screenshot, type Run } from "../src/show.ts";
import { fakePi, tempDir, withEnv } from "./helpers.ts";

const theme = { fg: (_c: string, s: string) => s } as any;

/** A fake browser: `--dump-dom` answers with the measured size, `--screenshot` writes the PNG. */
function fakeBrowser(size = "300x120") {
  const calls: string[][] = [];
  const pages: string[] = [];
  const exec: Run = async (_bin, args) => {
    calls.push(args);
    const url = args.at(-1)!;
    if (args.includes("--dump-dom")) {
      pages.push(await fs.readFile(new URL(url), "utf8"));
      return size ? `<html><head><title>size:${size}</title></head></html>` : "<html></html>";
    }
    const out = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
    await fs.writeFile(out, "png");
    return "";
  };
  return { calls, pages, exec };
}

async function setup(exec: Run, browser: () => string | undefined = () => "chromium") {
  const h = fakePi();
  registerShow(h.pi, exec, browser);
  const tool = h.tools.get("show");
  const root = await tempDir();
  const call = (params: object) => tool.execute("call/1", params, undefined, undefined, { cwd: root });
  return { tool, root, call };
}

test("findBrowser looks up Chromium or Chrome on the PATH", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, "google-chrome"), "", { mode: 0o755 });
  assert.equal(findBrowser(dir), path.join(dir, "google-chrome"));
  // Only the names given are looked up, so a Chrome app installed on a Mac cannot make this fail.
  assert.equal(findBrowser(await tempDir(), ["chromium", "google-chrome"]), undefined);
});

test("pageFor wraps a fragment, keeps a document, and points a file's page at its folder", async () => {
  assert.match(pageFor({ html: "<table></table>" }), /^<!doctype html><meta charset="utf-8"><body><table><\/table><\/body><script>/);
  assert.match(pageFor({ html: "<html><body>x</body></html>" }), /^<html><body>x<\/body><\/html><script>/);
  const dir = path.join(await tempDir(), "my $& mocks");
  await fs.mkdir(dir);
  const file = path.join(dir, "mock.html");
  await fs.writeFile(file, "<!DOCTYPE html><link rel=stylesheet href=app.css>");
  assert.ok(pageFor({ file }).startsWith(`<!DOCTYPE html><base href="${pathToFileURL(dir).href}/"><link`));
  await fs.writeFile(file, "<p>no doctype</p>");
  assert.ok(pageFor({ file }).startsWith(`<base href="${pathToFileURL(dir).href}/"><p>`));
  assert.ok(pageFor({ file: path.join(dir, "chart.svg") }).includes(`<img src="${pathToFileURL(path.join(dir, "chart.svg")).href}">`));
});

test("show passes an image file through without a browser", async () => {
  const { calls, exec } = fakeBrowser();
  const { root, call } = await setup(exec);
  await fs.writeFile(path.join(root, "plot.png"), "png");
  const r = await call({ file: "plot.png" });
  assert.deepEqual(r.details, { file: path.join(root, "plot.png"), mimeType: "image/png" });
  assert.match(r.content[0].text, /^Shown to the user: /);
  assert.deepEqual(calls, []);
  await assert.rejects(call({ file: "missing.png" }), /does not exist/);
  await fs.writeFile(path.join(root, "notes.txt"), "");
  await assert.rejects(call({ file: "notes.txt" }), /Cannot show \.txt/);
  await assert.rejects(call({}), /either file or html/);
  await assert.rejects(call({ file: "plot.png", html: "<p>" }), /either file or html/);
});

test("show renders markup at the measured size and keeps the page", async () => {
  const agent = await tempDir();
  await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => {
    const { calls, pages, exec } = fakeBrowser();
    const { call } = await setup(exec);
    const r = await call({ html: "<h1>Plan</h1>", width: 390 });
    assert.ok(calls[0].includes("--window-size=500,800") && calls[0].includes("--dump-dom"));
    assert.ok(calls[1].includes("--window-size=500,120") && calls[1].includes("--force-device-scale-factor=2"));
    assert.match(pages[0], /<h1>Plan<\/h1>/);
    const out = r.details.file;
    assert.equal(path.dirname(out), path.join(agent, "renders"));
    assert.match(path.basename(out), /^\d+-call1\.png$/);
    assert.equal(await fs.readFile(out, "utf8"), "png");
    assert.match(r.content[0].text, /^Shown to the user \(500x120\): .*\.png \(page: .*\.html\)$/);
    assert.deepEqual((await fs.readdir(path.join(agent, "renders"))).length, 2);
  });
});

test("screenshot measures the height again at a width the content needed beyond the requested one", async () => {
  const calls: string[][] = [];
  const exec: Run = async (_bin, args) => {
    calls.push(args);
    if (!args.includes("--dump-dom")) return "";
    // Wide content at 500; a media query makes the page taller once the window is 700 wide.
    return args.includes("--window-size=500,800") ? "<title>size:700x100</title>" : "<title>size:700x340</title>";
  };
  assert.deepEqual(await screenshot("chromium", "p.html", "p.png", 500, exec), { w: 700, h: 340 });
  assert.deepEqual(calls.map((c) => c.find((a) => a.startsWith("--window-size="))), ["--window-size=500,800", "--window-size=700,800", "--window-size=700,340"]);
});

test("screenshot removes a picture the browser left half written when it fails", async () => {
  const out = path.join(await tempDir(), "p.png");
  const exec: Run = async (_bin, args) => {
    if (args.includes("--dump-dom")) return "<title>size:500x100</title>";
    await fs.writeFile(out, "half");
    throw new Error("timed out");
  };
  await assert.rejects(screenshot("chromium", "p.html", out, 500, exec), /timed out/);
  await assert.rejects(fs.access(out));
});

test("show renders an HTML file without leaving its page behind, and fails clearly", async () => {
  const agent = await tempDir();
  await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => {
    const { exec } = fakeBrowser();
    const { root, call } = await setup(exec);
    await fs.writeFile(path.join(root, "mock.html"), "<p>hi</p>");
    const r = await call({ file: "mock.html" });
    assert.deepEqual(await fs.readdir(path.join(agent, "renders")), [path.basename(r.details.file)]);
    assert.doesNotMatch(r.content[0].text, /page:/);

    await assert.rejects((await setup(fakeBrowser("").exec)).call({ html: "<p>" }), /did not finish loading/);
    await assert.rejects((await setup(exec, () => undefined)).call({ html: "<p>" }), /No Chromium or Chrome/);
    assert.deepEqual(await fs.readdir(path.join(agent, "renders")), [path.basename(r.details.file)], "a failed render leaves no page");
  });
});

test("pruneRenders deletes only files older than the limit, and tolerates a missing folder", async () => {
  const dir = await tempDir();
  const now = Date.now();
  for (const [name, age] of [["old.png", 10_000], ["new.png", 1_000]] as const) {
    await fs.writeFile(path.join(dir, name), "x");
    const t = new Date(now - age);
    await fs.utimes(path.join(dir, name), t, t);
  }
  pruneRenders(dir, 5_000, now);
  assert.deepEqual(await fs.readdir(dir), ["new.png"]);
  pruneRenders(path.join(dir, "missing"), 5_000, now);

  // An old folder is left alone, and does not stop the files after it from going.
  await fs.mkdir(path.join(dir, "a-folder"));
  await fs.writeFile(path.join(dir, "z-old.png"), "x");
  await fs.utimes(path.join(dir, "a-folder"), new Date(now - 10_000), new Date(now - 10_000));
  await fs.utimes(path.join(dir, "z-old.png"), new Date(now - 10_000), new Date(now - 10_000));
  pruneRenders(dir, 5_000, now);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["a-folder", "new.png"]);
});

test("a wide measured page keeps its width, so the picture is not reflowed", async () => {
  const agent = await tempDir();
  await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => {
    const { calls, exec } = fakeBrowser("900x300");
    const { call } = await setup(exec);
    await call({ html: "<p>wide</p>", width: 700 });
    assert.ok(calls.at(-1)!.includes("--window-size=900,300"), "the window gets the measured width");
  });
});

test("the call gets a box colored by its state, and the picture goes below it", async () => {
  const { tool } = await setup(fakeBrowser().exec);
  assert.equal(tool.renderShell, "self", "inside pi's box, a picture whose top has scrolled off is left out");
  const paint = { ...theme, bg: (c: string, s: string) => `<${c}>${s}`, bold: (s: string) => s };
  const header = (args: object, context: object) => tool.renderCall(args, paint, { outputPad: 1, isError: false, isPartial: false, ...context }).render(40);
  assert.match(header({ file: "mock.html" }, { isPartial: true })[1], /^<toolPendingBg> show mock\.html/);
  assert.match(header({ html: "<p>" }, {})[1], /^<toolSuccessBg> show markup/);
  assert.match(header({ file: "x.png" }, { isError: true })[1], /^<toolErrorBg>/);
});

test("the result draws the picture once, with empty rows under it, or says why not", async () => {
  const { tool, root } = await setup(fakeBrowser().exec);
  const file = path.join(root, "plot.png");
  await fs.writeFile(file, "png");
  const result = (details?: object) => ({ content: [{ type: "text", text: "Shown to the user: plot.png" }], details });
  const draw = (details?: object, context: object = {}) =>
    tool.renderResult(result(details), { isPartial: false }, theme, { showImages: true, state: {}, outputPad: 1, isError: false, ...context });
  const text = (view: any) => view.render(80).join("");
  const state = {};
  const view = draw({ file, mimeType: "image/png" }, { state });
  const image = view.children[1];
  assert.ok(image instanceof Image);
  assert.equal(draw({ file }, { state }).children[1], image, "a redraw keeps the picture already sent");
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  try {
    const [spacer, anchor, ...covered] = view.render(80);
    assert.equal(spacer, "");
    assert.match(anchor, /^\x1b_G/);
    assert.ok(covered.length > 0 && covered.every((line: string) => line === ""), "pi-tui finds a picture scrolled past its top through empty rows only");
  } finally {
    resetCapabilitiesCache();
  }
  assert.ok(draw({ file }, { showImages: false }).children[1] instanceof Text, "pi's image setting is off");
  assert.match(text(draw({ file: path.join(root, "old.png") })), /old\.png is gone/);
  assert.match(text(draw()), /Shown to the user/);
});
