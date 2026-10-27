import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Image, Text } from "@earendil-works/pi-tui";
import { findBrowser, pageFor, registerShow, type Run } from "../src/show.ts";
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
  assert.equal(findBrowser(await tempDir()), undefined);
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
    assert.ok(calls[1].includes("--window-size=300,120") && calls[1].includes("--force-device-scale-factor=2"));
    assert.match(pages[0], /<h1>Plan<\/h1>/);
    const out = r.details.file;
    assert.equal(path.dirname(out), path.join(agent, "renders"));
    assert.match(path.basename(out), /^\d+-call1\.png$/);
    assert.equal(await fs.readFile(out, "utf8"), "png");
    assert.match(r.content[0].text, /^Shown to the user \(300x120\): .*\.png \(page: .*\.html\)$/);
    assert.deepEqual((await fs.readdir(path.join(agent, "renders"))).length, 2);
  });
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

test("the result draws the picture once, or says why not", async () => {
  const { tool, root } = await setup(fakeBrowser().exec);
  const file = path.join(root, "plot.png");
  await fs.writeFile(file, "png");
  const result = (details?: object) => ({ content: [{ type: "text", text: "Shown to the user: plot.png" }], details });
  const draw = (details?: object, context: object = {}) =>
    tool.renderResult(result(details), { isPartial: false }, theme, { showImages: true, state: {}, lastComponent: undefined, ...context });
  const image = draw({ file, mimeType: "image/png" });
  assert.ok(image instanceof Image);
  assert.equal(draw({ file }, { state: { file }, lastComponent: image }), image, "a redraw keeps the picture already sent");
  assert.ok(draw({ file }, { showImages: false }) instanceof Text, "pi's image setting is off");
  const gone = draw({ file: path.join(root, "old.png") });
  assert.ok(gone instanceof Text);
  assert.match(gone.render(80).join(""), /old\.png is gone/);
  assert.match(draw().render(80).join(""), /Shown to the user/);
});
