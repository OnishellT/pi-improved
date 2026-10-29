import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../subagent-ext.ts";

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

/** The user's own browser: `"auto"` (the first below whose debugging is on), a preset id, or any Chromium-compatible browser by the file it writes. */
export type RelayChoice = string | { id?: string; name?: string; portFile: string };
export type BrowserMode = "isolated" | "relay" | "both";
export const MODES: readonly BrowserMode[] = ["isolated", "relay", "both"];

/**
 * What the agent may use as its browser:
 * - `"off"` (default);
 * - `{ mode, relay? }`: `isolated` (headless Chromium from Nix, own profile), `relay` (the user's browser) or `both`;
 * - a relay choice on its own (`"auto"`, a preset id, `{ portFile }`): the old spelling of `{ mode: "relay", relay }`;
 * - `{ mcp }`: any MCP server (Playwright MCP, chrome-devtools-mcp, ...), used as is.
 */
export type BrowserChoice = RelayChoice | { mode: BrowserMode; relay?: RelayChoice } | { mcp: McpServerConfig };

export type BrowserPlan =
  | { kind: "off" }
  | { kind: "cdp"; targets: BrowserTarget[] }
  | { kind: "isolated" }
  | { kind: "both"; targets: BrowserTarget[] }
  | { kind: "mcp"; config: McpServerConfig };

export interface Platform {
  home: string;
  platform: string;
}
const here = (): Platform => ({ home: os.homedir(), platform: process.platform });

const supported = ({ platform }: Platform) => platform === "linux" || platform === "darwin";

const target = (b: (typeof BROWSERS)[number], { home, platform }: Platform): BrowserTarget => ({
  id: b.id,
  name: b.name,
  portFile: path.join(home, platform === "darwin" ? b.darwin : b.linux, "DevToolsActivePort"),
});

function planRelay(choice: RelayChoice, where: Platform): BrowserTarget[] {
  if (typeof choice === "string" && !supported(where)) throw new Error("Browser presets support Linux and macOS; use portFile or mcp.");
  if (choice === "auto") return BROWSERS.map((b) => target(b, where));
  if (typeof choice === "string") {
    const preset = BROWSERS.find((b) => b.id === choice);
    if (!preset) throw new Error(`Unknown browser "${choice}". Use off, auto, ${BROWSERS.map((b) => b.id).join(", ")}, { "portFile": … } or { "mcp": … }.`);
    return [target(preset, where)];
  }
  if (choice && typeof choice === "object" && "portFile" in choice && typeof choice.portFile === "string" && path.isAbsolute(choice.portFile)) {
    return [{ id: choice.id ?? "custom", name: choice.name ?? choice.id ?? "Browser", portFile: choice.portFile }];
  }
  throw new Error('browser needs "off", a mode, "auto", a preset id, { "portFile": "/absolute/path/DevToolsActivePort" } or { "mcp": { "command": … } }.');
}

/** Validates a config value and turns it into what gets registered. Throws a message the user can act on. */
export function planBrowser(choice: BrowserChoice | undefined, where = here()): BrowserPlan {
  if (choice === undefined || choice === "off") return { kind: "off" };
  if (choice && typeof choice === "object" && "mcp" in choice) {
    const mcp = choice.mcp as any;
    if (!mcp || typeof mcp !== "object" || (typeof mcp.command !== "string" && typeof mcp.url !== "string")) throw new Error('browser.mcp needs a "command" or a "url".');
    return { kind: "mcp", config: { exposure: "codemode", ...mcp } };
  }
  if (choice && typeof choice === "object" && "mode" in choice) {
    if (!MODES.includes(choice.mode)) throw new Error(`browser.mode must be ${MODES.map((m) => `"${m}"`).join(", ")}, not ${JSON.stringify(choice.mode)}.`);
    if (choice.mode === "isolated") return { kind: "isolated" };
    const targets = planRelay(choice.relay ?? "auto", where);
    return choice.mode === "both" ? { kind: "both", targets } : { kind: "cdp", targets };
  }
  return { kind: "cdp", targets: planRelay(choice as RelayChoice, where) };
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
  if (!supported(where)) return [];
  return BROWSERS.map((b) => {
    const { portFile } = target(b, where);
    return { id: b.id, name: b.name, installed: exists(path.dirname(portFile)), debugging: exists(portFile) };
  });
}

const serverFile = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "cdp-server.mjs");
const node = () => (/^node(\.exe)?$/.test(path.basename(process.execPath)) ? process.execPath : "node");

/** The bundled CDP server attached to the user's browser, told which browsers it may use (first with debugging on wins). */
export function cdpServer(targets: BrowserTarget[], alongsideIsolated = false): McpServerConfig {
  const names = targets.map((t) => t.name).join(", ");
  const when = alongsideIsolated ? " Use it only when the task needs the user's logged-in sessions or the user asks for their browser; otherwise use `browser`." : "";
  return {
    command: node(),
    args: [serverFile(), JSON.stringify(targets)],
    exposure: "codemode",
    description: `Your browser (${names}) with its existing logins, restricted to a new window this server creates. No personal tab enumeration. Human runtime-debugging approval required; subagents cannot connect.${when}`,
    timeout: 120,
  };
}

export const isolatedProfile = () => path.join(agentDir(), "browser-profile");

/** The command line of a process: /proc on Linux, `ps` on macOS. */
const processArgs = (pid: number) =>
  new Promise<string>((resolve) => {
    try {
      return resolve(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
    } catch {}
    execFile("ps", ["-p", String(pid), "-o", "args="], (_error, stdout) => resolve(stdout ?? ""));
  });

/**
 * The isolated Chromium outlives the pi session that started it (other sessions reuse it), so turning the browser off
 * stops it here. Chromium records its own pid in the profile's SingletonLock symlink ("host-pid"); read it now, and
 * kill it only when it is still that profile's browser. Without the symlink there is nothing to stop.
 */
export async function stopIsolated(profile = isolatedProfile(), args: (pid: number) => Promise<string> = processArgs, kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM")): Promise<boolean> {
  try {
    const pid = Number(fs.readlinkSync(path.join(profile, "SingletonLock")).split("-").pop());
    if (!Number.isInteger(pid) || pid <= 1 || !(await args(pid)).includes(`--user-data-dir=${profile}`)) return false;
    kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** The same server, starting its own headless Chromium (from Nix) on first use, with a persistent profile and none of the user's logins. */
export function isolatedServer(profile = isolatedProfile()): McpServerConfig {
  const targets = [{ id: "isolated", name: "Headless Chromium", portFile: path.join(profile, "DevToolsActivePort"), launch: { profile } }];
  return {
    command: node(),
    args: [serverFile(), JSON.stringify(targets)],
    exposure: "codemode",
    description: "A private headless Chromium with its own persistent profile (cookies of sites you log in to through it stay, none of the user's own). Starts on first use, no approval needed. The default for browsing, testing and scraping; subagents cannot connect.",
    timeout: 300, // the first start can download Chromium through Nix
  };
}
