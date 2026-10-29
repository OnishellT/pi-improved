import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, test } from "node:test";
import { resolveBin } from "../src/bin.ts";
import { credentialStatus, CHROMIUM, chromeEnv, chromeHeadless, clearNixCache, hasNix, installMessage, isNixFailure, exposeSubagent, nixExec, nixPackage, nixpkgsRev, NIXPKGS, type Spawn } from "../src/nix.ts";
import { agentDir } from "../src/subagent-ext.ts";
import { tempDir } from "./helpers.ts";

beforeEach(clearNixCache);

const missing = () => Object.assign(new Error("spawn nix ENOENT"), { code: "ENOENT" });

test("nixPackage builds the pinned attribute without flakes configured and picks the output that has bin/", async () => {
  const out = await tempDir();
  await fs.mkdir(path.join(out, "bin"));
  const calls: string[][] = [];
  const run: Spawn = async (_bin, args) => (calls.push(args), { code: 0, stdout: `/nix/store/x-man\n${out}\n`, stderr: "" });
  assert.equal(await nixPackage("tmux", run), out);
  assert.deepEqual(calls[0], ["--extra-experimental-features", "nix-command flakes", "build", "--out-link", path.join(agentDir(), "nix-roots", NIXPKGS.split("/").pop()!, "tmux"), "--print-out-paths", `${NIXPKGS}#tmux`], "a GC root under the pin the build uses: a collection cannot delete what any running session uses");
  const lock = JSON.parse(await fs.readFile(new URL("../flake.lock", import.meta.url), "utf8"));
  assert.equal(NIXPKGS, `github:NixOS/nixpkgs/${lock.nodes.nixpkgs.locked.rev}`);
  assert.match(await fs.readFile(new URL("../flake.nix", import.meta.url), "utf8"), new RegExp(lock.nodes.nixpkgs.locked.rev), "flake.nix and flake.lock pin the same rev");
});

test("nixPackage caches the path per attribute, and forgets a failure", async () => {
  let builds = 0;
  const run: Spawn = async () => (builds++, builds === 1 ? { code: 1, stdout: "", stderr: "error: unable to download" } : { code: 0, stdout: "/nix/store/y\n", stderr: "" });
  await assert.rejects(nixPackage("git", run), /Nix could not build git: error: unable to download.*network/);
  assert.equal(await nixPackage("git", run), "/nix/store/y");
  assert.equal(await nixPackage("git", run), "/nix/store/y");
  assert.equal(builds, 2);
  await nixPackage("gh", run);
  assert.equal(builds, 3);
});

test("nixPackage falls back to the installer's profile path, then reports the install command", async () => {
  const tried: string[] = [];
  const profileOnly: Spawn = async (bin) => {
    tried.push(bin);
    if (bin === "nix") throw missing();
    return { code: 0, stdout: "/nix/store/z\n", stderr: "" };
  };
  assert.equal(await nixPackage("bash", profileOnly), "/nix/store/z");
  assert.deepEqual(tried, ["nix", "/nix/var/nix/profiles/default/bin/nix"]);
  await assert.rejects(nixPackage("tmux", async () => Promise.reject(missing()), "linux", "x64"), /Nix is required[\s\S]*install \| sh -s -- --daemon/);
  assert.equal(await hasNix(async () => Promise.reject(missing())), false);
  assert.equal(await hasNix(async () => ({ code: 0, stdout: "nix 2", stderr: "" })), true);
});

test("the missing-Nix message names the command for the OS", () => {
  const linux = installMessage("linux", "x64");
  assert.match(linux, /nix\/install \| sh -s -- --daemon/);
  assert.match(linux, /WSL/);
  const mac = installMessage("darwin", "arm64");
  assert.match(mac, /nix\/install \| sh\n/);
  assert.doesNotMatch(mac, /--daemon|Intel/);
  assert.match(installMessage("darwin", "x64"), /Intel Macs are unsupported for the headless browser/);
  assert.match(installMessage("win32", "x64"), /Linux, WSL and macOS/);
});

test("chromeHeadless finds the executable whatever the platform folder is called", async () => {
  const out = await tempDir();
  await fs.mkdir(path.join(out, "locales"));
  await fs.mkdir(path.join(out, "chrome-headless-shell-mac-arm64"));
  await fs.writeFile(path.join(out, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"), "");
  assert.equal(await chromeHeadless(async (attr) => (assert.equal(attr, CHROMIUM), out)), path.join(out, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"));
  await assert.rejects(chromeHeadless(async () => tempDir()), /no chrome-headless-shell executable/);
});

test("chromeEnv points fontconfig at Nix's DejaVu plus the host fonts", async () => {
  const dir = await tempDir();
  const env = await chromeEnv(async () => "/nix/store/dejavu", dir);
  assert.equal(env.FONTCONFIG_FILE, path.join(dir, "browser-fonts.conf"));
  const conf = await fs.readFile(env.FONTCONFIG_FILE, "utf8");
  assert.match(conf, /<dir>\/nix\/store\/dejavu\/share\/fonts<\/dir>/);
  assert.match(conf, /<dir>\/usr\/share\/fonts<\/dir>/);
});

test("nixExec puts the Nix dirs first on the PATH of git, gh, bash and the subagent CLI, and leaves other commands alone", async () => {
  const calls: [string, string[]][] = [];
  const exec = async (cmd: string, args: string[]) => (calls.push([cmd, args]), { stdout: "ok", stderr: "", code: 0, killed: false });
  const run = nixExec(exec, async (attr) => `/nix/store/${attr}`, "/usr/bin:/bin");
  await run("git", ["status"], { cwd: "/", timeout: 1 });
  await run("gh", ["pr", "list"], { cwd: "/", timeout: 1 });
  await run("bash", ["-lc", "npm test"], { cwd: "/", timeout: 1 });
  await run(resolveBin("subagent"), ["spawn"], { cwd: "/", timeout: 1 });
  await run("node", ["-v"], { cwd: "/", timeout: 1 });
  assert.deepEqual(calls[0], ["env", ["PATH=/nix/store/git/bin:/usr/bin:/bin", "git", "status"]]);
  assert.deepEqual(calls[1], ["env", ["PATH=/nix/store/gh/bin:/nix/store/git/bin:/usr/bin:/bin", "gh", "pr", "list"]]);
  assert.equal(calls[2][1][0], "PATH=/nix/store/bash/bin:/nix/store/git/bin:/usr/bin:/bin");
  // A login profile can reset PATH, so the dirs are put back in front inside the script, after the profile ran.
  assert.deepEqual(calls[2][1].slice(2), ["-lc", `export PATH='/nix/store/bash/bin:/nix/store/git/bin':"$PATH"; npm test`]);
  assert.deepEqual(calls[3], ["env", ["PATH=/nix/store/tmux/bin:/usr/bin:/bin", resolveBin("subagent"), "spawn"]]);
  assert.deepEqual(calls[4], ["node", ["-v"]]);
});

test("nixExec fails the call with the install message instead of running the command when Nix is missing", async () => {
  let ran = 0;
  const exec = async () => (ran++, { stdout: "", stderr: "", code: 0, killed: false });
  const run = nixExec(exec, async () => Promise.reject(new Error(installMessage("linux", "x64"))));
  const r = await run("tmux", ["-V"], { cwd: "/", timeout: 1 });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /Nix is required/);
  assert.equal(ran, 0);
});

test("nixExec stops waiting for a slow build at the call's timeout or abort, and the next call uses the finished build", async () => {
  let ran = 0;
  const exec = async () => (ran++, { stdout: "ok", stderr: "", code: 0, killed: false });
  let finish!: (out: string) => void;
  const build = new Promise<string>((resolve) => (finish = resolve));
  const run = nixExec(exec, () => build);
  const late = await run("git", ["status"], { cwd: "/", timeout: 20 });
  assert.equal(late.code, 127);
  assert.ok(isNixFailure(late), "reported like a failed build, so the gate and /pr say so");
  assert.match(late.stderr, /Nix could not build git in time: the build goes on/);
  const abort = new AbortController();
  const aborted = run("git", ["status"], { cwd: "/", timeout: 60_000, signal: abort.signal });
  abort.abort();
  assert.equal((await aborted).code, 127);
  assert.equal(ran, 0);
  finish("/nix/store/x-git");
  assert.equal((await run("git", ["status"], { cwd: "/", timeout: 20 })).stdout, "ok");
  assert.equal(ran, 1);
});

test("nixpkgsRev reads the rev from a lock file and rejects one without it", async () => {
  const dir = await tempDir();
  const ok = path.join(dir, "ok.lock");
  await fs.writeFile(ok, JSON.stringify({ nodes: { nixpkgs: { locked: { rev: "a".repeat(40) } } } }));
  assert.equal(nixpkgsRev(ok), "a".repeat(40));
  await fs.writeFile(path.join(dir, "bad.lock"), "{}");
  assert.throws(() => nixpkgsRev(path.join(dir, "bad.lock")), /no pinned nixpkgs rev/);
});

/** A Nix git double: `--exec-path` is a folder shipping only the store helper, `config` lists `helpers`. */
async function fakeGit(helpers: string[]) {
  const exec = await tempDir();
  await fs.writeFile(path.join(exec, "git-credential-store"), "");
  const run: Spawn = async (_bin, args) =>
    args[0] === "--exec-path"
      ? { code: 0, stdout: `${exec}\n`, stderr: "" }
      : { code: helpers.length ? 0 : 1, stdout: helpers.map((h) => `credential.helper ${h}\n`).join(""), stderr: "" };
  return run;
}
const resolve = async (attr: string) => `/nix/store/${attr}`;

test("credentialStatus: by-name helpers Nix git does not ship are missing; paths, shell helpers and shipped ones work", async () => {
  const gh = await tempDir();
  await fs.writeFile(path.join(gh, "gh"), "");
  const status = async (helpers: string[]) => (clearNixCache(), credentialStatus(resolve, await fakeGit(helpers)));
  assert.deepEqual(await status([]), { configured: [], missing: [], ok: false });
  assert.deepEqual(await status(["libsecret"]), { configured: ["libsecret"], missing: ["libsecret"], ok: false });
  assert.equal((await status(["osxkeychain", "store"])).ok, true);
  assert.equal((await status([`${gh}/gh auth git-credential`])).ok, true);
  assert.equal((await status(["/nowhere/gh auth git-credential"])).ok, false);
  assert.equal((await status(["!f() { :; }; f"])).ok, true);
});

test("git push gets gh as its github.com helper on that call only, when Nix git has no working one", async () => {
  const calls: string[][] = [];
  const exec = async (_cmd: string, args: string[]) => (calls.push(args), { stdout: "", stderr: "", code: 0, killed: false });
  const opts = { cwd: "/", timeout: 10_000 };
  clearNixCache();
  const bare = nixExec(exec, resolve, "/bin", await fakeGit(["libsecret"]));
  await bare("git", ["push", "-u", "origin", "b"], opts);
  await bare("git", ["status"], opts);
  assert.deepEqual(calls[0].slice(1, 6), ["git", "-c", "credential.https://github.com.helper=!/nix/store/gh/bin/gh auth git-credential", "push", "-u"]);
  assert.deepEqual(calls[1].slice(1), ["git", "status"], "local commands are left alone");
  calls.length = 0;
  clearNixCache();
  const working = nixExec(exec, resolve, "/bin", await fakeGit(["store"]));
  await working("git", ["push"], opts);
  assert.deepEqual(calls[0].slice(1), ["git", "push"]);
  // The gh build for that helper is bounded by the call's timeout too.
  calls.length = 0;
  clearNixCache();
  const slowGh = nixExec(exec, (attr) => (attr === "gh" ? new Promise<string>(() => {}) : resolve(attr)), "/bin", await fakeGit(["libsecret"]));
  const late = await slowGh("git", ["push"], { cwd: "/", timeout: 50 });
  assert.equal(late.code, 127);
  assert.match(late.stderr, /Nix could not build git, gh in time/);
  assert.equal(calls.length, 0);
});

test("exposeSubagent puts the bundled CLI's folder and the Nix tmux first on PATH, once", async () => {
  const root = await tempDir();
  const cli = path.join(root, ".bundled", "pi-subagent", "subagent.ts");
  await fs.mkdir(path.join(root, ".bundled", "bin"), { recursive: true });
  await fs.mkdir(path.dirname(cli));
  await fs.writeFile(cli, "");
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  await exposeSubagent(env, cli, async () => "/nix/store/x-tmux");
  assert.equal(env.PATH, ["/nix/store/x-tmux/bin", "/usr/bin"].join(path.delimiter), "no link: only tmux to expose");
  env.PATH = "/usr/bin";
  await fs.symlink("../pi-subagent/subagent.ts", path.join(root, ".bundled", "bin", "subagent"));
  await exposeSubagent(env, cli, async () => "/nix/store/x-tmux");
  await exposeSubagent(env, cli, async () => "/nix/store/x-tmux");
  assert.equal(env.PATH, ["/nix/store/x-tmux/bin", path.join(root, ".bundled", "bin"), "/usr/bin"].join(path.delimiter));
  const noNix: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  await exposeSubagent(noNix, cli, async () => { throw new Error("no nix"); });
  assert.equal(noNix.PATH, [path.join(root, ".bundled", "bin"), "/usr/bin"].join(path.delimiter), "the CLI still shows; tmux fails and /doctor says why");
  const global: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  await exposeSubagent(global, cli, async () => "/nix/store/x-tmux", false);
  assert.equal(global.PATH, ["/nix/store/x-tmux/bin", "/usr/bin"].join(path.delimiter), "a global pi-subagent has its own CLI: only tmux is added");
  // The CLI shows before a slow tmux build ends: a bash call that stops waiting for it still finds `subagent` (and the system tmux).
  const slow: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  let release!: () => void;
  const pending = exposeSubagent(slow, cli, () => new Promise((resolve) => (release = () => resolve("/nix/store/x-tmux"))));
  assert.equal(slow.PATH, [path.join(root, ".bundled", "bin"), "/usr/bin"].join(path.delimiter));
  release();
  await pending;
  assert.equal(slow.PATH, ["/nix/store/x-tmux/bin", path.join(root, ".bundled", "bin"), "/usr/bin"].join(path.delimiter));
});
