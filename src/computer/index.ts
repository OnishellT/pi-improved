import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { browserStates, cdpServer, isolatedServer, planBrowser, stopIsolated, type BrowserChoice, type BrowserMode, type Platform, type RelayChoice } from "./browsers.ts";
import { globalPath } from "../config.ts";
import { migrateGlobal } from "../legacy-config.ts";
import { definedInMcpJson, readComputerConfig, writeComputerConfig, type ComputerConfig } from "./config.ts";
import { desktopMissing, desktopOffered, desktopServer, desktopWrapper } from "./desktop.ts";

const KEEP = "No changes";
const AUTO = "Auto: the first browser with remote debugging on";
const OFF = "Off";
const MODES: [string, BrowserMode][] = [
  ["Isolated: a private headless Chromium with its own profile, no approval", "isolated"],
  ["Relay: your own browser, with your logins (you approve remote debugging)", "relay"],
  ["Both: the isolated one as `browser`, yours as `my-browser`", "both"],
];

export function describeBrowser(choice: unknown): string {
  if (choice === undefined) return "off";
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    if ("mcp" in choice) return "custom MCP server";
    if ("mode" in choice) return typeof choice.mode === "string" ? `${choice.mode}${choice.mode === "isolated" ? "" : ` (relay: ${describeBrowser((choice as { relay?: unknown }).relay ?? "auto")})`}` : "invalid";
    const { name, portFile } = choice as { name?: unknown; portFile?: unknown };
    if (typeof portFile === "string") return `custom (${typeof name === "string" ? name : portFile})`;
  }
  return "invalid";
}

const modeOf = (browser: BrowserChoice | undefined) => (browser && typeof browser === "object" && "mode" in browser ? browser.mode : undefined);
const usesRelay = (browser: BrowserChoice | undefined) => browser !== undefined && browser !== "off" && modeOf(browser) !== "isolated" && !(typeof browser === "object" && "mcp" in browser);
const usesIsolated = (browser: BrowserChoice | undefined) => modeOf(browser) === "isolated" || modeOf(browser) === "both";

const desktopState = (config: ComputerConfig) => (config.desktop === "on" ? "on" : "off");

/** Registers or removes the `browser`, `my-browser` and `desktop` MCP servers so they match the config, and exports $PI_DESKTOP while the bundled desktop is registered. */
export function computerServers(pi: ExtensionAPI, dir?: string, profile?: string) {
  const live = new Set<string>();
  const set = (name: string, config: McpServerConfig | undefined) => {
    if (config) {
      pi.registerMcpServer(name, config);
      live.add(name);
    } else if (live.delete(name)) pi.unregisterMcpServer(name);
  };
  // $PI_DESKTOP belongs to the person until we export it; we hand back what was there.
  let exported = false;
  let previous: string | undefined;
  const exportDesktop = (wrapper: string | undefined) => {
    if (wrapper !== undefined) {
      if (!exported) previous = process.env.PI_DESKTOP;
      exported = true;
      process.env.PI_DESKTOP = wrapper;
    } else if (exported) {
      exported = false;
      if (previous === undefined) delete process.env.PI_DESKTOP;
      else process.env.PI_DESKTOP = previous;
    }
  };
  /** Returns what could not be applied, in words the user can act on. */
  return (config: ComputerConfig, where?: Platform, pathEnv?: string): string[] => {
    const problems: string[] = [];
    const shadowed = (name: string) => {
      const yes = definedInMcpJson(name, dir);
      if (yes) problems.push(`mcp.json already defines "${name}" and wins over this extension: remove that entry to use the bundled one.`);
      return yes;
    };
    try {
      const plan = planBrowser(config.browser, where);
      const browser = plan.kind === "isolated" || plan.kind === "both" ? isolatedServer(profile) : plan.kind === "cdp" ? cdpServer(plan.targets) : plan.kind === "mcp" ? plan.config : undefined;
      set("browser", browser && !shadowed("browser") ? browser : undefined);
      set("my-browser", plan.kind === "both" && !shadowed("my-browser") ? cdpServer(plan.targets, true) : undefined);
    } catch (error: any) {
      set("browser", undefined);
      set("my-browser", undefined);
      problems.push(error.message);
    }
    if (config.desktop !== undefined && config.desktop !== "on" && config.desktop !== "off") problems.push(`desktop must be "on" or "off", not ${JSON.stringify(config.desktop)}.`);
    const missing = config.desktop === "on" ? desktopMissing(pathEnv) : [];
    if (missing.length) problems.push(`Desktop is on but needs: ${missing.join(", ")}.`);
    try {
      const offered = desktopOffered(config, pathEnv, undefined, dir);
      if (config.desktop === "on" && !missing.length && !offered) shadowed("desktop"); // the only remaining reason: it reports itself
      set("desktop", offered ? desktopServer() : undefined);
    } catch (error: any) {
      problems.push(error.message);
    }
    // Shell steps and the bash tool inherit this, so scripts can call the bundled desktop without a machine-specific path.
    exportDesktop(live.has("desktop") ? desktopWrapper() : undefined);
    return problems;
  };
}

export async function registerComputer(pi: ExtensionAPI) {
  const apply = computerServers(pi);
  let problems: string[];
  // computer.json moves into the global file before the first read; the notice waits for a UI.
  const moved = migrateGlobal();
  try {
    problems = apply(await readComputerConfig());
  } catch (error: any) {
    problems = [error.message];
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (moved.length) ctx.ui.notify(moved.join("\n"), "info");
    moved.length = 0;
    if (!problems.length) return;
    ctx.ui.notify(`Computer use: ${problems.join(" ")} Run /computer.`, "warning");
    problems = [];
  });

  pi.registerCommand("computer", {
    description: "Choose the browser and desktop the agent can drive",
    handler: async (_args, ctx) => {
      let config: ComputerConfig;
      try {
        config = await readComputerConfig();
      } catch (error: any) {
        ctx.ui.notify(error.message, "warning");
        return;
      }

      const next: ComputerConfig = { ...config };
      const mode = await ctx.ui.select(`Browser the agent can drive (now: ${describeBrowser(config.browser)})`, [KEEP, ...MODES.map(([label]) => label), OFF]);
      const picked = MODES.find(([label]) => label === mode)?.[1];
      if (mode === OFF) next.browser = "off";
      else if (picked) {
        let relay: RelayChoice | undefined;
        if (picked !== "isolated") {
          const choices = new Map<string, RelayChoice>([[AUTO, "auto"]]);
          for (const s of browserStates()) if (s.installed || s.debugging) choices.set(`${s.name}${s.debugging ? " · remote debugging on" : ""}`, s.id);
          const chosen = await ctx.ui.select("Your browser (the one with your logins)", [...choices.keys()]);
          relay = chosen ? choices.get(chosen) : undefined;
        }
        // Cancelled relay pick: keep what was there instead of guessing.
        if (picked === "isolated") next.browser = { mode: "isolated" };
        else if (relay !== undefined) next.browser = { mode: picked, relay };
      }

      const missing = desktopMissing();
      if (!missing.length || config.desktop === "on") {
        const desktop = await ctx.ui.select(
          `Desktop: a private Hyprland session the agent drives (Pi must run inside Hyprland) (now: ${desktopState(config)}${missing.length ? `; missing: ${missing.join(", ")}` : ""})`,
          [KEEP, "On", "Off"],
        );
        if (desktop === "On" || desktop === "Off") next.desktop = desktop === "On" ? "on" : "off";
      }

      if (JSON.stringify(next) !== JSON.stringify(config)) await writeComputerConfig(next);
      const problems = apply(next);
      // The isolated browser is left running for other sessions: turning it off is what stops it.
      const stopped = usesIsolated(config.browser) && !usesIsolated(next.browser) && (await stopIsolated());
      ctx.ui.notify(
        [
          ...(stopped ? ["The isolated browser was stopped."] : []),
          `Browser: ${describeBrowser(next.browser)}. Desktop: ${desktopState(next)}. Config: ${globalPath()}.`,
          ...(missing.length && next.desktop !== "on" ? [`Desktop is not offered here: it needs ${missing.join(", ")}.`] : []),
          ...(usesRelay(next.browser) ? ["The first use of your browser asks you to approve remote debugging in it (chrome://inspect/#remote-debugging)."] : []),
          ...(usesIsolated(next.browser) ? ["The isolated browser needs Nix; its first start downloads Chromium (run /doctor to fetch it first)."] : []),
          "Any other Chromium browser (a port file) or MCP server (Playwright MCP…): edit that file.",
          ...problems,
        ].join("\n"),
        problems.length ? "warning" : "info",
      );
    },
  });
}

export default async function (pi: ExtensionAPI) {
  await registerComputer(pi);
}
