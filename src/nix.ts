import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBin } from "./bin.ts";
import { which } from "./computer/which.ts";
import type { Exec } from "./git.ts";
import { agentDir } from "./subagent-ext.ts";

// Imported by the standalone CDP server too (a .mjs run by plain Node): keep it free of pi imports.

/** The nixpkgs rev recorded in flake.lock: the one pin for the flake's pi and for every binary pi-improved runs, so all machines get the same tmux, git and browser. */
export const nixpkgsRev = (lock = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flake.lock")): string => {
  const rev = JSON.parse(fs.readFileSync(lock, "utf8"))?.nodes?.nixpkgs?.locked?.rev;
  if (typeof rev !== "string" || !/^[0-9a-f]{40}$/.test(rev)) throw new Error(`${lock} has no pinned nixpkgs rev`);
  return rev;
};
/** Read once: the build URL and its GC root must name the same pin, even if the checkout is updated while pi runs. */
const REV = nixpkgsRev();
export const NIXPKGS = `github:NixOS/nixpkgs/${REV}`;
export const CHROMIUM = "playwright-driver.components.chromium-headless-shell";
const NIX_PROFILE_BIN = "/nix/var/nix/profiles/default/bin/nix"; // where the installer puts it, even when the shell's PATH lacks it
const BUILD_TIMEOUT = 20 * 60_000; // the first run downloads hundreds of MB

export type Spawn = (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const spawn: Spawn = (bin, args) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: BUILD_TIMEOUT, maxBuffer: 5e6 }, (err: any, stdout, stderr) => {
      if (err?.code === "ENOENT") reject(err);
      else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    }),
  );

/** What to run to get Nix, for the user's OS. The commands are from nixos.org/download (multi-user installs). */
export const NIX_MISSING = "Nix is required and was not found";

export function installMessage(platform: string = process.platform, arch: string = process.arch): string {
  const base = NIX_MISSING;
  if (platform === "linux") return `${base}. Install it (on WSL, systemd must be enabled):\n  curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --daemon\nThen restart pi.`;
  if (platform === "darwin") {
    const intel = arch === "x64" ? " Intel Macs are unsupported for the headless browser (show, isolated browser): nixpkgs dropped x86_64-darwin." : "";
    return `${base}. Install it:\n  curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh\nThen restart pi.${intel}`;
  }
  return `${base}, and pi-improved supports Linux, WSL and macOS. See https://nixos.org/download.`;
}

export const NIX_BUILD_FAILED = "Nix could not build";

export class NixError extends Error {}

/** A command result that `nixExec` produced because Nix is missing or could not build its package (not because the command itself failed). */
export const isNixMissing = (r: { code: number; stderr: string }) => r.code === 127 && [NIX_MISSING, NIX_BUILD_FAILED].some((m) => r.stderr?.startsWith(m));

const cache = new Map<string, Promise<string>>();
let credentials: Promise<CredentialStatus> | undefined;
export const clearNixCache = () => (cache.clear(), (credentials = undefined));

/** Builds (or finds) a pinned nixpkgs attribute and returns the output that has `bin/`, else the first. Cached for the process. */
export function nixPackage(attr: string, run: Spawn = spawn, platform = process.platform, arch = process.arch): Promise<string> {
  let hit = cache.get(attr);
  if (!hit) {
    hit = build(attr, run, platform, arch);
    cache.set(attr, hit);
    hit.catch(() => cache.delete(attr)); // a failure (offline, no Nix yet) must not stick
  }
  return hit;
}

async function build(attr: string, run: Spawn, platform: string, arch: string): Promise<string> {
  // Flags on the command line: it works without the user enabling flakes. The out-link is a GC root: a garbage
  // collection during a session cannot delete a path it caches or put on PATH. One folder per pin, so a session on a
  // newer pin does not replace the root an older one still uses (delete nix-roots/ to free them all).
  const args = ["--extra-experimental-features", "nix-command flakes", "build", "--out-link", path.join(agentDir(), "nix-roots", REV, attr), "--print-out-paths", `${NIXPKGS}#${attr}`];
  let result;
  for (const nix of ["nix", NIX_PROFILE_BIN]) {
    try {
      result = await run(nix, args);
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!result) throw new NixError(installMessage(platform, arch));
  const outs = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (result.code !== 0 || !outs.length) {
    const why = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new NixError(`${NIX_BUILD_FAILED} ${attr}${why ? `: ${why}` : ""}. Check your network and disk space, then run /doctor.`);
  }
  return outs.find((o) => fs.existsSync(path.join(o, "bin"))) ?? outs[0];
}

/** The headless shell's executable. Its folder name carries the platform (chrome-headless-shell-linux64, -mac-arm64…). */
export async function chromeHeadless(resolve: (attr: string) => Promise<string> = nixPackage): Promise<string> {
  const out = await resolve(CHROMIUM);
  for (const dir of fs.readdirSync(out).filter((d) => d.startsWith("chrome-headless-shell-"))) {
    const exe = path.join(out, dir, "chrome-headless-shell");
    if (fs.existsSync(exe)) return exe;
  }
  throw new NixError(`${CHROMIUM} (${out}) has no chrome-headless-shell executable.`);
}

/**
 * Environment for the headless shell: a fontconfig file with Nix's DejaVu next to the host's font folders, so text
 * renders on a bare machine and keeps the host's fonts where it has them.
 */
export async function chromeEnv(resolve: (attr: string) => Promise<string> = nixPackage, dir = agentDir()): Promise<Record<string, string>> {
  const dejavu = path.join(await resolve("dejavu_fonts"), "share", "fonts");
  const dirs = [dejavu, "/usr/share/fonts", "/usr/local/share/fonts", "/run/current-system/sw/share/X11/fonts", "/Library/Fonts", "/System/Library/Fonts", path.join(os.homedir(), ".local/share/fonts")];
  const file = path.join(dir, "browser-fonts.conf");
  const conf = `<?xml version="1.0"?>\n<fontconfig>\n${dirs.map((d) => `  <dir>${d}</dir>`).join("\n")}\n  <cachedir prefix="xdg">fontconfig</cachedir>\n</fontconfig>\n`;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== conf) fs.writeFileSync(file, conf);
  return { FONTCONFIG_FILE: file };
}

/** Whether a Nix binary runs. Cheap: builds nothing. */
export async function hasNix(run: Spawn = spawn): Promise<boolean> {
  for (const nix of ["nix", NIX_PROFILE_BIN]) {
    try {
      if ((await run(nix, ["--version"])).code === 0) return true;
    } catch {}
  }
  return false;
}

export interface CredentialStatus {
  /** Helpers configured for https://github.com, in order. */
  configured: string[];
  /** Those Nix git cannot run: a bare name needs `git-credential-<name>` in its exec path or on PATH (it ships only cache, store and netrc). */
  missing: string[];
  /** At least one configured helper can run. */
  ok: boolean;
}

/**
 * The credential helpers git would try for github.com, and whether Nix git can run them. A helper given by absolute path
 * or as `!shell` works with any git; one given by name (libsecret, manager, osxkeychain) is found only next to the git
 * that ships it, and Nix git neither has them nor reads Apple's system gitconfig that sets osxkeychain.
 */
export function credentialStatus(resolve: (attr: string) => Promise<string> = nixPackage, run: Spawn = spawn): Promise<CredentialStatus> {
  credentials ??= (async () => {
    const git = path.join(await resolve("git"), "bin", "git");
    const execPath = (await run(git, ["--exec-path"])).stdout.trim();
    const listed = await run(git, ["config", "--get-regexp", "^credential\\.(https://github\\.com\\.)?helper$"]);
    let configured: string[] = [];
    for (const line of listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : []) {
      const value = line.replace(/^\S+\s?/, "").trim();
      configured = value ? [...configured, value] : []; // an empty value resets the list
    }
    const works = (helper: string) => {
      if (helper.startsWith("!")) return true;
      const [name] = helper.split(/\s+/);
      if (path.isAbsolute(name)) return fs.existsSync(name);
      return fs.existsSync(path.join(execPath, `git-credential-${name}`)) || Boolean(which(`git-credential-${name}`));
    };
    const missing = configured.filter((h) => !works(h));
    return { configured, missing, ok: configured.length > missing.length };
  })();
  credentials.catch(() => (credentials = undefined));
  return credentials;
}

/** The only login: gh's. Its helper is passed on the call, never written to a config (store paths change after a GC). */
async function credentialArgs(resolve: (attr: string) => Promise<string>, run: Spawn): Promise<string[]> {
  try {
    if ((await credentialStatus(resolve, run)).ok) return [];
    return ["-c", `credential.https://github.com.helper=!${path.join(await resolve("gh"), "bin", "gh")} auth git-credential`];
  } catch {
    return []; // git itself reports what is missing
  }
}

/** Which packages a command needs on its PATH. The subagent CLI calls tmux itself. */
const NETWORK = /^(push|fetch|pull|clone|ls-remote)$/;
const NEEDS: Record<string, string[]> = { git: ["git"], gh: ["gh", "git"], bash: ["bash", "git"], tmux: ["tmux"] };

/**
 * Runs the commands above with their Nix packages first on PATH (the inherited PATH follows, so a verify step still
 * finds the project's own tools). With Nix missing or a build failing, the call fails like a command: code 127 and the
 * message as stderr, which the callers already show.
 */
export function nixExec(exec: Exec, resolve: (attr: string) => Promise<string> = nixPackage, inherited = process.env.PATH ?? "", run: Spawn = spawn): Exec {
  return async (cmd, args, options) => {
    const need = cmd === resolveBin("subagent") ? ["tmux"] : NEEDS[cmd];
    if (!need) return exec(cmd, args, options);
    const network = cmd === "git" && NETWORK.test(args[0] ?? "");
    // The login helper may need a gh build of its own: the same bound covers it.
    const prepare = async () => {
      const dirs = (await Promise.all(need.map((a) => resolve(a)))).map((out) => path.join(out, "bin"));
      return { dirs, login: network ? await credentialArgs(resolve, run) : [] };
    };
    let dirs: string[], login: string[];
    try {
      ({ dirs, login } = await bounded(prepare(), network ? [...need, "gh"] : need, options));
    } catch (error: any) {
      return { stdout: "", stderr: error.message, code: 127, killed: false };
    }
    const first = dirs.join(path.delimiter);
    // A login shell's profile may reset PATH: put the Nix dirs back in front once it has run, keeping what the profile added.
    const script = cmd === "bash" && args[0] === "-lc" && typeof args[1] === "string" ? [args[0], `export PATH='${first}':"$PATH"; ${args[1]}`, ...args.slice(2)] : args;
    return exec("env", [`PATH=${[...dirs, inherited].filter(Boolean).join(path.delimiter)}`, cmd, ...login, ...script], options);
  };
}

/**
 * The caller's timeout and abort cover the build too, not only the command: a first build can take minutes, and a
 * hook awaiting a 30 s git call must not wait that long. The build goes on and stays cached for the next call.
 */
function bounded<T>(work: Promise<T>, need: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<T> {
  const { timeout, signal } = options ?? {};
  if (!timeout && !signal) return work;
  return new Promise<T>((resolve, reject) => {
    const late = () => reject(new NixError(`${NIX_BUILD_FAILED} ${need.join(", ")} in time: the build goes on in the background. Try again shortly, or run /doctor to wait for it.`));
    const timer = timeout ? setTimeout(late, timeout) : undefined;
    if (signal?.aborted) late();
    signal?.addEventListener("abort", late, { once: true });
    work.then(resolve, reject).finally(() => (clearTimeout(timer), signal?.removeEventListener("abort", late)));
  });
}

const prepend = (env: NodeJS.ProcessEnv, dir: string) => {
  const parts = (env.PATH ?? "").split(path.delimiter).filter((d) => d && d !== dir);
  env.PATH = [dir, ...parts].join(path.delimiter);
};

/**
 * The subagent skill has the model's bash run `subagent spawn`, and that CLI starts children in tmux: put the Nix tmux
 * (and, when it is the bundled pi-subagent, its CLI, linked by scripts/postinstall.mjs) on the PATH pi's bash tool
 * inherits. A global pi-subagent brings its own CLI but still needs this tmux, the one the panes and /doctor use.
 * Awaited at startup, so tmux is on PATH before any command runs. Without Nix the CLI still shows; `subagent` then
 * fails on tmux and /doctor says why.
 */
export async function exposeSubagent(env = process.env, cli = resolveBin("subagent"), resolve: (attr: string) => Promise<string> = nixPackage, bundled = true): Promise<void> {
  // The CLI first, before the tmux build: a bash call that stops waiting for the build still finds `subagent`.
  const bin = path.join(path.dirname(path.dirname(cli)), "bin");
  if (bundled && path.isAbsolute(cli) && fs.existsSync(path.join(bin, "subagent"))) prepend(env, bin);
  try {
    prepend(env, path.join(await resolve("tmux"), "bin"));
  } catch {}
}
