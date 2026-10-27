import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { agentDir } from "../subagent-ext.ts";
import type { BrowserChoice } from "./browsers.ts";

/** User-level (`<agent dir>/computer.json`): browsers and logins belong to the person, not to a repo. Everything is off until chosen. */
export interface ComputerConfig {
  browser?: BrowserChoice;
  desktop?: "on" | "off";
}

export const configPath = (dir = agentDir()) => path.join(dir, "computer.json");

/** `{}` when the file does not exist. Throws a readable error when it exists but is not a JSON object. */
export async function readComputerConfig(dir = agentDir()): Promise<ComputerConfig> {
  let text: string;
  try {
    text = await fs.readFile(configPath(dir), "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new Error(`${configPath(dir)} is not a JSON object`);
}

export async function writeComputerConfig(config: ComputerConfig, dir = agentDir()) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath(dir), `${JSON.stringify(config, null, 2)}\n`);
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
