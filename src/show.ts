import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { which } from "./computer/which.ts";
import { agentDir } from "./subagent-ext.ts";

/** Runs a program and resolves with its stdout; rejects when it fails or times out. */
export type Run = (bin: string, args: string[]) => Promise<string>;

const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const BROWSERS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const MIN_WIDTH = 500; // headless Chromium lays pages out at least this wide
const MAX_WIDTH = 2400;
const MAX_HEIGHT = 4000;
const MAX_BYTES = 10e6;
// Puts the content's size in the title, where `--dump-dom` can read it: the viewport would pad a short page. The range
// covers text straight in the body, which no element bounds.
const MEASURE = `<script>addEventListener("load", () => setTimeout(() => {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const boxes = [range, ...document.body.querySelectorAll("*")].map((e) => e.getBoundingClientRect());
  const edge = (side) => Math.ceil(Math.max(0, ...boxes.map((b) => b[side])));
  const body = getComputedStyle(document.body);
  const gap = (side) => Math.max(parseFloat(body["padding" + side]) + parseFloat(body["margin" + side]), 8);
  document.title = "size:" + Math.ceil(edge("right") + gap("Right")) + "x" + Math.ceil(edge("bottom") + gap("Bottom"));
}))</script>`;

const run: Run = (bin, args) =>
  new Promise((resolve, reject) => execFile(bin, args, { timeout: 30_000, maxBuffer: 50e6 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

export function findBrowser(pathEnv = process.env.PATH ?? "", candidates = BROWSERS): string | undefined {
  for (const b of candidates) {
    const found = path.isAbsolute(b) ? (fs.existsSync(b) ? b : undefined) : which(b, pathEnv);
    if (found) return found;
  }
  return undefined;
}

/** Deletes the files in dir last modified more than maxAgeMs before now; best effort, an entry at a time. */
export function pruneRenders(dir: string, maxAgeMs: number, now = Date.now()) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const f of names) {
    try {
      const file = path.join(dir, f);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < now - maxAgeMs) fs.rmSync(file, { force: true });
    } catch {}
  }
}

/** Renders a page to a PNG as wide as the page was laid out and as tall as its content, at twice the CSS pixels. */
export async function screenshot(browser: string, page: string, out: string, width: number, exec: Run = run) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-show-"));
  const url = pathToFileURL(page).href;
  const flags = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${profile}`, "--virtual-time-budget=5000"];
  try {
    const measure = async (at: number) => {
      const dom = await exec(browser, [...flags, `--window-size=${at},800`, "--dump-dom", url]);
      const size = /<title>size:(\d+)x(\d+)<\/title>/.exec(dom);
      if (!size) throw new Error("the page did not finish loading in 5 s");
      return { w: Number(size[1]), h: Number(size[2]) };
    };
    const first = await measure(width);
    // Never narrower than the page was laid out: a narrower window would reflow it and trim its right padding.
    const w = Math.min(Math.max(first.w, width), MAX_WIDTH);
    // A wider window can reflow the page (a media query), so its height is measured again at the width it gets.
    const h = Math.min(w > width ? (await measure(w)).h : first.h, MAX_HEIGHT);
    try {
      await exec(browser, [...flags, "--force-device-scale-factor=2", `--window-size=${w},${h}`, `--screenshot=${out}`, url]);
    } catch (err) {
      fs.rmSync(out, { force: true }); // a browser that timed out may have left a partial picture
      throw err;
    }
    return { w, h };
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** The page to render: markup as given (a fragment gets a document around it), or a file with its folder as the base URL. */
export function pageFor(source: { html?: string; file?: string }): string {
  if (source.file?.toLowerCase().endsWith(".svg")) return `<!doctype html><body><img src="${pathToFileURL(source.file).href}">${MEASURE}`;
  if (source.file) {
    const base = `<base href="${pathToFileURL(path.dirname(source.file) + path.sep).href}">`;
    return fs.readFileSync(source.file, "utf8").replace(/^(\s*<!doctype[^>]*>)?/i, (_m, doctype = "") => doctype + base) + MEASURE;
  }
  const html = source.html ?? "";
  return (/<html|<body/i.test(html) ? html : `<!doctype html><meta charset="utf-8"><body>${html}</body>`) + MEASURE;
}

// Pictures in the chat (Kitty or iTerm2 image protocol: Tern, Kitty, Ghostty, WezTerm, iTerm2). The model gets the
// path only, so a picture costs no image tokens. pi already draws ```mermaid blocks as text, so diagrams go there.
export function registerShow(pi: ExtensionAPI, exec: Run = run, browser = findBrowser) {
  pi.registerTool({
    name: "show",
    label: "Show",
    description:
      "Show the user a picture in the chat: a PNG, JPEG, GIF, WebP, SVG or HTML file, or HTML/SVG markup (UI mockups, styled tables, layouts). For a data chart, save it as a PNG first (matplotlib or similar) and show the file. For flowchart, sequence, class, state or ER diagrams, write a ```mermaid block in your reply instead: pi draws it. You get back the picture's path, not the picture.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Path of the image, SVG or HTML file" })),
      html: Type.Optional(Type.String({ description: "HTML or SVG markup, when there is no file" })),
      width: Type.Optional(Type.Number({ description: "Page width in CSS pixels for HTML (default 1000, at least 500)" })),
    }),
    exposure: "model-only",
    async execute(id, { file, html, width }, _signal, _update, ctx) {
      if (!file === !html) throw new Error("Pass either file or html.");
      const abs = file && path.resolve(ctx.cwd, file);
      const ext = abs ? path.extname(abs).toLowerCase() : ".html";
      if (abs && !fs.existsSync(abs)) throw new Error(`${file} does not exist.`);
      if (abs && IMAGES[ext]) {
        if (fs.statSync(abs).size > MAX_BYTES) throw new Error(`${file} is over 10 MB: resize it first.`);
        return { content: [{ type: "text", text: `Shown to the user: ${abs}` }], details: { file: abs, mimeType: IMAGES[ext] } };
      }
      if (ext !== ".html" && ext !== ".htm" && ext !== ".svg") throw new Error(`Cannot show ${ext} files: use PNG, JPEG, GIF, WebP, SVG or HTML.`);
      const bin = browser();
      if (!bin) throw new Error("No Chromium or Chrome found for HTML and SVG: install one, or show a PNG instead.");
      const dir = path.join(agentDir(), "renders");
      fs.mkdirSync(dir, { recursive: true });
      pruneRenders(dir, 7 * 24 * 3600e3);
      const name = `${Date.now()}-${id.replace(/[^\w-]/g, "")}`;
      const page = path.join(dir, `${name}.html`);
      const out = path.join(dir, `${name}.png`);
      fs.writeFileSync(page, pageFor({ html, file: abs }));
      const { w, h } = await screenshot(bin, page, out, Math.min(Math.max(width ?? 1000, MIN_WIDTH), MAX_WIDTH), exec).catch((err) => {
        fs.rmSync(page, { force: true });
        throw err;
      });
      // Markup has no file of its own: keep the page so the user can open it in a browser.
      if (abs) fs.rmSync(page, { force: true });
      const kept = abs ? "" : ` (page: ${page})`;
      return { content: [{ type: "text", text: `Shown to the user (${w}x${h}): ${out}${kept}` }], details: { file: out, mimeType: "image/png" } };
    },
    // The picture goes below the call's colored box, where pi puts its own pictures: inside the box, the padding fills
    // the rows the picture covers, and pi-tui then leaves out a picture whose top has scrolled off the screen.
    renderShell: "self",
    renderCall({ file }, theme, context) {
      const bg = context.isError ? "toolErrorBg" : context.isPartial ? "toolPendingBg" : "toolSuccessBg";
      const header = new Box(context.outputPad, 1, (s) => theme.bg(bg, s));
      header.addChild(new Text(`${theme.fg("toolTitle", theme.bold("show"))} ${theme.fg("muted", file ?? "markup")}`, 0, 0));
      return header;
    },
    renderResult(result, { isPartial }, theme, context) {
      const { file, mimeType } = (result.details ?? {}) as { file?: string; mimeType?: string };
      const note = (text: string) => new Text(theme.fg(context.isError ? "error" : "muted", text), context.outputPad, 0);
      const view = new Container();
      view.addChild(new Spacer(1));
      if (isPartial || !file || !context.showImages) {
        view.addChild(note(result.content.map((c) => (c.type === "text" ? c.text : "")).join("")));
        return view;
      }
      // A new Image would send the picture to the terminal again on every redraw.
      if (context.state.file !== file) {
        try {
          const data = fs.readFileSync(file).toString("base64");
          context.state.image = new Image(data, mimeType ?? "image/png", { fallbackColor: (s) => theme.fg("muted", s) }, { filename: path.basename(file), maxWidthCells: 100 });
          context.state.file = file;
        } catch {
          view.addChild(note(`${file} is gone`));
          return view;
        }
      }
      view.addChild(context.state.image);
      return view;
    },
  });
}
