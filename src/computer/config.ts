import * as fsSync from "node:fs";
import * as path from "node:path";
import { globalPath, isObject, readGlobal, updateGlobal } from "../config.ts";
import { agentDir } from "../subagent-ext.ts";
import type { BrowserChoice } from "./browsers.ts";

/** The `computer` key of the global file (`<agent dir>/pi-improved.json`): browsers and logins belong to the person, not to a repo, so a project file cannot set it. Everything is off until chosen. */
export interface ComputerConfig {
  browser?: BrowserChoice;
  desktop?: "on" | "off";
}

/** `{}` when the key is missing. Throws a readable error when the file is not valid or the key is not an object. */
export async function readComputerConfig(dir = agentDir()): Promise<ComputerConfig> {
  const config = readGlobal(dir).computer;
  if (config === undefined) return {};
  if (!isObject(config)) throw new Error(`"computer" in ${globalPath(dir)} is not a JSON object`);
  return config;
}

/** Saves the choice under `computer`, keeping the rest of the global file. */
export async function writeComputerConfig(config: ComputerConfig, dir = agentDir()) {
  updateGlobal((c) => void (c.computer = config), dir);
}

/** Pi connects `mcp.json` servers first: an entry of the same name wins over the extension's, and `pi.getMcpServers()` does not list it. */
export function definedInMcpJson(name: string, dir = agentDir()): boolean {
  try {
    const entry = JSON.parse(fsSync.readFileSync(path.join(dir, "mcp.json"), "utf8"))?.mcpServers?.[name];
    return Boolean(entry); // a disabled entry still overrides a registered server
  } catch {
    return false;
  }
}
