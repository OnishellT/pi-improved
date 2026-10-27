import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { browserStates, cdpServer, planBrowser, type BrowserChoice, type Platform } from "./browsers.ts";
import { configPath, definedInMcpJson, readComputerConfig, writeComputerConfig, type ComputerConfig } from "./config.ts";
import { desktopMissing, desktopOffered, desktopServer, desktopWrapper } from "./desktop.ts";

const KEEP = "No changes";
const AUTO = "Auto: the first browser with remote debugging on";
const OFF = "Off";

export function describeBrowser(choice: unknown): string {
  if (choice === undefined) return "off";
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    if ("mcp" in choice) return "custom MCP server";
    const { name, portFile } = choice as { name?: unknown; portFile?: unknown };
    if (typeof portFile === "string") return `custom (${typeof name === "string" ? name : portFile})`;
  }
  return "invalid";
}

const desktopState = (config: ComputerConfig) => (config.desktop === "on" ? "on" : "off");

/** Registers or removes the `browser` and `desktop` MCP servers so they match the config, and exports $PI_DESKTOP while the bundled desktop is registered. */
export function computerServers(pi: ExtensionAPI, dir?: string) {
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
      set("browser", plan.kind === "off" || shadowed("browser") ? undefined : plan.kind === "cdp" ? cdpServer(plan.targets) : plan.config);
    } catch (error: any) {
      set("browser", undefined);
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
  try {
    problems = apply(await readComputerConfig());
  } catch (error: any) {
    problems = [error.message];
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !problems.length) return;
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

      const choices = new Map<string, BrowserChoice>([[AUTO, "auto"]]);
      for (const s of browserStates()) if (s.installed || s.debugging) choices.set(`${s.name}${s.debugging ? " · remote debugging on" : ""}`, s.id);
      choices.set(OFF, "off");
      const browser = await ctx.ui.select(`Browser the agent can drive (now: ${describeBrowser(config.browser)})`, [KEEP, ...choices.keys()]);
      const next: ComputerConfig = { ...config };
      if (browser && choices.has(browser)) next.browser = choices.get(browser);

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
      ctx.ui.notify(
        [
          `Browser: ${describeBrowser(next.browser)}. Desktop: ${desktopState(next)}. Config: ${configPath()}.`,
          ...(missing.length && next.desktop !== "on" ? [`Desktop is not offered here: it needs ${missing.join(", ")}.`] : []),
          ...(next.browser === undefined || next.browser === "off" ? [] : ["The first use asks you to approve remote debugging in the browser (chrome://inspect/#remote-debugging)."]),
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
