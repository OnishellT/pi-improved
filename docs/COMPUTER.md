# Computer use

Optional second extension (`src/computer/`). It lets the agent drive a browser and a desktop. Off until you choose.

## Use

`/computer` lists the browsers installed, marks those with remote debugging on, and saves your pick under the `computer` key of `pi-improved.json` in the Pi agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), keeping the other keys of that file. User level on purpose: logins belong to you, not to a repo, so a project's `.pi/workflow.json` cannot set it. An old `computer.json` is copied into that key once, at startup, and no longer read. It applies at once, with no restart.

## Config

The value of the `computer` key:

```json
{ "browser": { "mode": "both", "relay": "auto" }, "desktop": "on" }
```

| Key | Values |
|-----|--------|
| `browser` | `off` (default). `{ "mode": "isolated" }`: a private headless Chromium, no approval. `{ "mode": "relay", "relay": … }`: your own browser. `{ "mode": "both", "relay": … }`: both. `relay` is `auto` (the first browser with remote debugging on: helium, chrome, chromium, brave, edge, vivaldi), a preset id, or `{ "portFile": "/abs/path/DevToolsActivePort", "name": "Mine" }` for any other Chromium browser. The old values `"auto"`, a preset id and `{ "portFile" }` still work and mean relay. `{ "mcp": { "command": "npx", "args": ["@playwright/mcp@latest"] } }` for any MCP server, used as given. |
| `desktop` | `off` (default), `on` |

Isolated (and relay mode) is the MCP server `browser`, the desktop is `desktop`. In `both`, the isolated one is `browser` and yours is `my-browser`; its description tells the model to use `my-browser` only when the task needs your logins. `/computer` asks for the mode first, then, for relay and both, which browser. A server of the same name in the agent dir's `mcp.json` wins, even a disabled one: the extension then registers nothing and warns, so remove that entry to use the bundled one. (Project-level MCP config is not checked.)

## Isolated browser

The bundled server launches the headless Chromium (chrome-headless-shell) from Nix on first use, with a persistent profile at `<agent dir>/browser-profile`, so logins you make in it stay for later runs but are never your own browser's. No approval is needed. It needs Nix (`/doctor` checks it); the browser keeps running when the pi session ends, so other sessions reuse it (a session never kills a browser another one is using). Choosing Off in `/computer` (or a mode without the isolated browser) stops it; Chromium itself records its pid in `<profile>/SingletonLock` (it also refuses a second browser on the profile), and that is what /computer reads. Its tools and rules are the same as for the relay browser below, so subagents cannot open pages. Unlike the relay window, the window a session opens closes when its server exits, and a browser that died is started again on the next `open`.

## Relay browser

The bundled server (Node >= 22, like the rest of the package) attaches to a browser you already use, with its logins, through remote debugging (`chrome://inspect/#remote-debugging`). The first `open` needs your approval in that browser. If you deny it or it times out, later calls fail with "disconnected" instead of asking again; reconnect the MCP server to retry. Several candidates (`auto`) are tried in order; a debugging file left by a browser that is gone is skipped. A browser that is running but refuses the connection is the answer: no other browser is asked.

The rules below hold for the bundled server only. An `{ "mcp": … }` server is used as given, with whatever rules it has.

- Works only in a new window it creates. Never lists or attaches to your tabs, never reads cookies or passwords, never closes the browser.
- http(s) and `about:blank` only, no credentials in URLs.
- Subagents get `status` only.

The window it creates stays open when the server exits (or if you close it by hand, the next `open` makes a new one); call `close` to close it. Browser presets support Linux and macOS only; on other systems use `portFile` or `mcp`.

Verified end to end with Helium. The other presets share its code path and folder layout. The macOS folders are unverified.

## Desktop

A private nested 1280x800 Hyprland session with its own cursor, keyboard and session bus. Input is confined to windows it launched. Subagents are read-only. Pi must itself run inside a Hyprland session, which the nested one attaches to. Needs Linux, Hyprland, dbus (`dbus-run-session`), python3 and [`hypruse`](https://pypi.org/project/hypruse/) (`uv tool install hypruse`, with [uv](https://docs.astral.sh/uv/); `pipx install hypruse` also works). `/doctor` lists what is missing while the desktop is on.

The nested session starts on first use, is detached, and keeps running after Pi exits (other Pi sessions reuse it). Its log is `/run/user/<uid>/pi-desktop/startup.log`; to stop it, kill the `Hyprland --config …/hyprland.lua` process whose config is this package's.

It refuses to attach to a compositor started from another `hyprland.lua`: the check pins the config path, so it also trips after the package is moved or reinstalled elsewhere. The error names the process to stop. Moving from a hand-made setup: remove the `desktop` entry from `mcp.json` and stop the old private compositor first.

## Verification

Gates run shell commands and trust exit codes, so only command line tools can gate. With the desktop on, `/setup` tells the model it may use the `pi-desktop` shell verbs in the `verify-app` script. The script calls `${PI_DESKTOP:-pi-desktop}`: `/computer` exports `PI_DESKTOP` for the bundled one, otherwise a `pi-desktop` on your PATH is used. The script never carries an absolute path, because it is committed and runs on other machines. MCP-only drivers, including the browser above, are for the model's own exploration, not for a gate.
