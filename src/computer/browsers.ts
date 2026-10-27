import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

/**
 * Chromium-family browsers share one protocol: with remote debugging enabled
 * (chrome://inspect/#remote-debugging) the browser writes `DevToolsActivePort` into its user-data dir.
 * Only Helium is verified end to end; the others share its code path and folder layout.
 */
export const BROWSERS = [
  { id: "helium", name: "Helium", linux: ".config/net.imput.helium", darwin: "Library/Application Support/net.imput.helium" },
  { id: "chrome", name: "Google Chrome", linux: ".config/google-chrome", darwin: "Library/Application Support/Google/Chrome" },
  { id: "chromium", name: "Chromium", linux: ".config/chromium", darwin: "Library/Application Support/Chromium" },
  { id: "brave", name: "Brave", linux: ".config/BraveSoftware/Brave-Browser", darwin: "Library/Application Support/BraveSoftware/Brave-Browser" },
  { id: "edge", name: "Microsoft Edge", linux: ".config/microsoft-edge", darwin: "Library/Application Support/Microsoft Edge" },
  { id: "vivaldi", name: "Vivaldi", linux: ".config/vivaldi", darwin: "Library/Application Support/Vivaldi" },
] as const;

export interface BrowserTarget {
  id: string;
  name: string;
  portFile: string;
}

/**
 * What the agent may use as its browser:
 * - `"off"` (default) or `"auto"` (the first browser below whose debugging is on) or a preset id;
 * - `{ portFile }`: any Chromium-compatible browser, by the file it writes;
 * - `{ mcp }`: any MCP server (Playwright MCP, chrome-devtools-mcp, ...), used as is.
 */
export type BrowserChoice = string | { id?: string; name?: string; portFile: string } | { mcp: McpServerConfig };

export type BrowserPlan = { kind: "off" } | { kind: "cdp"; targets: BrowserTarget[] } | { kind: "mcp"; config: McpServerConfig };

export interface Platform {
  home: string;
  platform: string;
}
const here = (): Platform => ({ home: os.homedir(), platform: process.platform });

const target = (b: (typeof BROWSERS)[number], { home, platform }: Platform): BrowserTarget => ({
  id: b.id,
  name: b.name,
  portFile: path.join(home, platform === "darwin" ? b.darwin : b.linux, "DevToolsActivePort"),
});

export const browserIds = () => BROWSERS.map((b) => b.id as string);

/** Validates a config value and turns it into what gets registered. Throws a message the user can act on. */
export function planBrowser(choice: BrowserChoice | undefined, where = here()): BrowserPlan {
  if (choice === undefined || choice === "off") return { kind: "off" };
  if (choice === "auto") return { kind: "cdp", targets: BROWSERS.map((b) => target(b, where)) };
  if (typeof choice === "string") {
    const preset = BROWSERS.find((b) => b.id === choice);
    if (!preset) throw new Error(`Unknown browser "${choice}". Use off, auto, ${browserIds().join(", ")}, { "portFile": … } or { "mcp": … }.`);
    return { kind: "cdp", targets: [target(preset, where)] };
  }
  if (choice && typeof choice === "object" && "mcp" in choice) {
    const mcp = choice.mcp as any;
    if (!mcp || typeof mcp !== "object" || (typeof mcp.command !== "string" && typeof mcp.url !== "string")) throw new Error('browser.mcp needs a "command" or a "url".');
    return { kind: "mcp", config: { exposure: "codemode", ...mcp } };
  }
  if (choice && typeof choice === "object" && "portFile" in choice && typeof choice.portFile === "string" && path.isAbsolute(choice.portFile)) {
    return { kind: "cdp", targets: [{ id: choice.id ?? "custom", name: choice.name ?? choice.id ?? "Browser", portFile: choice.portFile }] };
  }
  throw new Error('browser needs "off", "auto", a preset id, { "portFile": "/absolute/path/DevToolsActivePort" } or { "mcp": { "command": … } }.');
}

export interface BrowserState {
  id: string;
  name: string;
  /** Its user-data folder exists. */
  installed: boolean;
  /** Remote debugging is on right now. */
  debugging: boolean;
}

export function browserStates(where = here(), exists: (file: string) => boolean = fs.existsSync): BrowserState[] {
  return BROWSERS.map((b) => {
    const { portFile } = target(b, where);
    return { id: b.id, name: b.name, installed: exists(path.dirname(portFile)), debugging: exists(portFile) };
  });
}

const serverFile = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "cdp-server.mjs");
const node = () => (/node/.test(path.basename(process.execPath)) ? process.execPath : "node");

/** The bundled CDP server, told which browsers it may attach to (first with debugging on wins). */
export function cdpServer(targets: BrowserTarget[]): McpServerConfig {
  const names = targets.map((t) => t.name).join(", ");
  return {
    command: node(),
    args: [serverFile(), JSON.stringify(targets)],
    exposure: "codemode",
    description: `Your browser (${names}) with its existing logins, restricted to a new window this server creates. No personal tab enumeration. Human runtime-debugging approval required; subagents cannot connect.`,
    timeout: 120,
  };
}
