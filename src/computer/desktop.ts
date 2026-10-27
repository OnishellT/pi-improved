import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { definedInMcpJson, type ComputerConfig } from "./config.ts";
import { which } from "./which.ts";

/** Private Hyprland desktop (nested, 1280x800) driven by hypruse. It never touches the user's own seat. */
export const desktopWrapper = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop", "pi-desktop");

/** Linux only: needs Hyprland (to nest), dbus, hypruse and python3. Checked by lookup, nothing is started. */
export function desktopMissing(pathEnv = process.env.PATH ?? "", home = os.homedir()): string[] {
  // The wrapper requires the uv/pipx copy to be executable before it falls back to PATH.
  const hypruse = which("hypruse", path.join(home, ".local/bin")) || which("hypruse", pathEnv);
  return [
    ...(process.platform === "linux" ? [] : ["Linux"]),
    ...(which("hyprctl", pathEnv) ? [] : ["hyprctl (Hyprland)"]),
    ...(hypruse ? [] : ["hypruse (uv tool install hypruse)"]),
    ...(which("dbus-run-session", pathEnv) ? [] : ["dbus-run-session (dbus)"]),
    ...(which("python3", pathEnv) ? [] : ["python3"]),
  ];
}

/** The one rule for "the bundled desktop is on and usable": the extension registers it and exports $PI_DESKTOP exactly then. */
export const desktopOffered = (config: ComputerConfig, pathEnv?: string, home?: string, dir?: string) =>
  config.desktop === "on" && !desktopMissing(pathEnv, home).length && !definedInMcpJson("desktop", dir);

export const desktopServer = (): McpServerConfig => ({
  command: desktopWrapper(),
  exposure: "codemode",
  description:
    "Private 1280x800 Hyprland desktop, separate cursor/keyboard/session bus from the user. Starts on first use and keeps running after Pi exits. Input confined to windows this server launched; subagents read-only. Use codemode.",
  timeout: 30,
  toolExposure: { use_bind: "hidden", clipboard: "hidden" },
});
