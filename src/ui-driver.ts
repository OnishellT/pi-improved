import { readComputerConfig, type ComputerConfig } from "./computer/config.ts";
import { desktopOffered } from "./computer/desktop.ts";
import { which } from "./computer/which.ts";

/**
 * Shell tools that drive a GUI for the `verify-app` script. Only a command line tool can gate:
 * `verify` runs plain commands and trusts their exit code, so MCP-only drivers do not belong here.
 * `call` is how the script invokes it: the bundled desktop is exported by /computer as $PI_DESKTOP,
 * and a committed script must not carry a path that exists only on this machine.
 */
export const UI_DRIVERS = [
  {
    bin: "pi-desktop",
    call: '"${PI_DESKTOP:-pi-desktop}"',
    use: "drives a private desktop that never touches the user's: `launch -- CMD`, `ui`, `click_ui NAME`, `keyboard type TEXT`, `wait_for EVENT`, `screenshot --out .pi/evidence/<name>.png`. `{call} VERB --help` lists the flags. Exit codes: 0 ok, 1 error, 2 usage, 3 refused, 4 no result. Write the call exactly as shown, never as an absolute path: the script is committed and runs on other machines. Its session files live under /run/user, outside the repo: the one exception to the rule above. If the driver is missing on another machine (a teammate, CI), the script must print `SKIPPED: no GUI driver` and exit 0 for the GUI part only; keep the headless checks mandatory. Never call bare `hypruse`: it acts on the user's own seat.",
  },
];

/**
 * Drivers the script can use: one on PATH, or the bundled desktop when /computer turned it on.
 * Looked up, never run: some start a session on first use.
 */
export async function detectUiDrivers(pathEnv = process.env.PATH ?? "", agentDir?: string, home?: string): Promise<string[]> {
  const config = await readComputerConfig(agentDir).catch(() => ({}) as ComputerConfig);
  const bundled = desktopOffered(config, pathEnv, home, agentDir);
  return UI_DRIVERS.filter(({ bin }) => which(bin, pathEnv) || (bin === "pi-desktop" && bundled)).map(({ bin }) => bin);
}

export const uiDriverHint = (bins: string[]) =>
  UI_DRIVERS.filter(({ bin }) => bins.includes(bin))
    .map(({ call, use }) => `\`${call}\` ${use.replaceAll("{call}", call)}`)
    .join(" ");
