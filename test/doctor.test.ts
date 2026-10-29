import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionDetail, nodeOk, registerDoctor, runDoctor, type NixProbe } from "../src/doctor.ts";
import { fakePi, tempProject, withEnv } from "./helpers.ts";

const models = [{ provider: "anthropic", id: "opus" }];
const setup = async (exec: (cmd: string, args: string[]) => any, hasUI = true, mode?: string, extra = {}, nix: NixProbe = { has: async () => true, resolve: async (attr) => `/nix/store/x-${attr}` }) => {
  const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], mode, models: { implement: "anthropic/opus", review: "openai/gpt-5" }, ...extra }) });
  const notes: { msg: string; level: string }[] = [];
  const ctx: any = { cwd: root, hasUI, modelRegistry: { getAvailable: () => models }, ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } };
  const h = fakePi(exec);
  registerDoctor(h.pi, nix);
  return { ...h, ctx, notes };
};

test("node version gate", () => {
  assert.ok(nodeOk("v22.19.0") && nodeOk("24.0.1"));
  assert.ok(!nodeOk("22.18.0") && !nodeOk("20.11.0"));
});

test("/doctor lists missing models with a login hint and failing CLIs", async () => {
  const t = await setup((cmd) => (cmd === "git" ? { code: 0 } : { code: 1 }));
  await t.commands.get("doctor").handler("", t.ctx);
  const { msg, level } = t.notes[0];
  assert.equal(level, "warning");
  assert.match(msg, /✗ subagent/);
  assert.match(msg, /✓ git/);
  assert.match(msg, /openai\/gpt-5[\s\S]*\/login <provider>[^\n]*openai/);
});

test("agentlint is checked only when the project runs it", async () => {
  const fail = (cmd: string) => (cmd === "git" ? { code: 0 } : { code: 1 });
  const unused = await setup(fail);
  await unused.commands.get("doctor").handler("", unused.ctx);
  assert.doesNotMatch(unused.notes[0].msg, /agentlint/);
  const used = await setup(fail, true, undefined, { agentlint: "npm exec agentlint --" });
  await used.commands.get("doctor").handler("", used.ctx);
  assert.match(used.notes[0].msg, /✗ agentlint: not found/);
});

test("session_start warns once, only with a UI, and only when something is missing", async () => {
  const t = await setup(() => ({ code: 0 }));
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].msg, /Models/);
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.equal(t.notes.length, 1);
});

test("session_start never runs a command through Nix: no subagent probe, no build", async () => {
  const ran: string[] = [];
  const t = await setup((cmd) => (ran.push(cmd), { code: 0 }), true, undefined, {}, { has: async () => true, resolve: async () => assert.fail("built at session start") });
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.ok(!ran.some((c) => /subagent/.test(c)), ran.join(","));
  assert.ok(!t.notes.some((n) => /subagent/.test(n.msg)), t.notes.map((n) => n.msg).join("|"));
});

test("/doctor validates mode: absent and valid pass, anything else fails", async () => {
  for (const [mode, ok] of [[undefined, true], ["direct", true], ["flow", true], ["turbo", false]] as const) {
    const t = await setup(() => ({ code: 0 }), true, mode);
    await t.commands.get("doctor").handler("", t.ctx);
    const msg = t.notes[0].msg;
    assert.equal(/✗ mode:/.test(msg), !ok, String(mode));
    if (mode === "turbo") assert.match(msg, /"direct" or "flow"/);
  }
});

test("/doctor flags option values the code would read as another value, and unknown skills", async () => {
  const t = await setup(() => ({ code: 0 }), true, undefined, { review: { minLevel: "medium" }, useAgentlint: "Never", useBend: "never", skills: { plan: ["no-such-skill"], review: "pstack-review" } });
  await t.commands.get("doctor").handler("", t.ctx);
  const msg = t.notes[0].msg;
  assert.match(msg, /✗ review\.minLevel: "medium" is not valid: use "off", "low" or "high"/);
  assert.match(msg, /✗ useAgentlint: "Never" is not valid/);
  assert.match(msg, /✓ useBend: never/);
  assert.match(msg, /✗ Skills: skills\.plan: unknown skill "no-such-skill"; skills\.review is not a list/);
});

test("the agentlint check runs the project's own command", async () => {
  const ran: string[] = [];
  const t = await setup((cmd, args) => (ran.push([cmd, ...args].join(" ")), { code: 0 }), true, undefined, { agentlint: "pnpm agentlint" });
  await t.commands.get("doctor").handler("", t.ctx);
  assert.ok(ran.includes("bash -lc pnpm agentlint --help"), ran.join("\n"));
  ran.length = 0;
  await runDoctor(t.pi, t.ctx, undefined, { has: async () => true });
  assert.ok(!ran.some((c) => c.includes("pnpm agentlint")), "never at session start");
});

test("/doctor reports a corrupt workflow.json as a problem instead of throwing", async () => {
  const t = await setup(() => ({ code: 0 }));
  await fs.writeFile(path.join(t.ctx.cwd, ".pi/workflow.json"), "{ nope");
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.notes[0].msg, /✗ Manifest: .*not valid JSON/);
});

test("/doctor resolves each Nix package and reports it; a failure carries the reason", async () => {
  const ok = await setup(() => ({ code: 0 }));
  await ok.commands.get("doctor").handler("", ok.ctx);
  assert.match(ok.notes[0].msg, /✓ Nix: ok[\s\S]*✓ tmux: \/nix\/store\/x-tmux[\s\S]*✓ gh[\s\S]*✓ bash/);
  const failing = await setup(() => ({ code: 0 }), true, undefined, {}, { has: async () => true, resolve: async (attr) => (attr === "tmux" ? Promise.reject(new Error("Nix could not build tmux: offline")) : "/nix/store/x") });
  await failing.commands.get("doctor").handler("", failing.ctx);
  assert.match(failing.notes[0].msg, /✗ tmux: Nix could not build tmux: offline \(the subagent review/);
});

test("without Nix, /doctor says how to install it and builds nothing", async () => {
  let built = 0;
  const t = await setup(() => ({ code: 0 }), true, undefined, {}, { has: async () => false, resolve: async () => (built++, "x") });
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.notes[0].msg, /✗ Nix: Nix is required[\s\S]*nixos\.org\/nix\/install/);
  assert.equal(built, 0);
});

test("at session start Nix is only probed, never built", async () => {
  const t = await setup(() => ({ code: 0 }));
  const checks = await runDoctor(t.pi, t.ctx, undefined, { has: async () => true });
  assert.ok(checks.some((c: any) => c.name === "Nix" && c.ok));
  assert.ok(!checks.some((c: any) => c.name === "tmux"));
});

test("/doctor says gh is the one login when the configured helper is not available to Nix git", async () => {
  const nix = (credentials: any): NixProbe => ({ has: async () => true, resolve: async () => "/nix/store/x", credentials });
  const broken = await setup(() => ({ code: 0 }), true, undefined, {}, nix(async () => ({ configured: ["libsecret"], missing: ["libsecret"], ok: false })));
  await broken.commands.get("doctor").handler("", broken.ctx);
  assert.match(broken.notes[0].msg, /✓ git credentials: the configured helper \(libsecret\) is not available to the Nix git, so pi-improved uses your gh login/);
  const loggedOut = await setup((cmd, args) => ({ code: cmd === "gh" && args[0] === "auth" ? 1 : 0 }), true, undefined, {}, nix(async () => ({ configured: [], missing: [], ok: false })));
  await loggedOut.commands.get("doctor").handler("", loggedOut.ctx);
  assert.match(loggedOut.notes[0].msg, /✗ git credentials: no credential helper is configured\. Run `gh auth login` \(no gh on your PATH: `nix [^`]*run github:NixOS\/nixpkgs\/[0-9a-f]{40}#gh -- auth login`\): it is the one login/);
  assert.doesNotMatch(loggedOut.notes[0].msg, /gh login/);
  const helperNoGh = await setup((cmd, args) => ({ code: cmd === "gh" && args[0] === "auth" ? 1 : 0 }), true, undefined, {}, nix(async () => ({ configured: ["store"], missing: [], ok: true })));
  await helperNoGh.commands.get("doctor").handler("", helperNoGh.ctx);
  assert.match(helperNoGh.notes[0].msg, /✓ git credentials: helper: store[\s\S]*✗ gh login: not logged in, and \/pr needs it/);
  const fine = await setup(() => ({ code: 0 }), true, undefined, {}, nix(async () => ({ configured: ["store"], missing: [], ok: true })));
  await fine.commands.get("doctor").handler("", fine.ctx);
  assert.match(fine.notes[0].msg, /✓ git credentials: helper: store[\s\S]*✓ gh login: ok/);
});

test("the desktop is checked only while it is on, and names what it needs", async () => {
  const empty = await tempProject({});
  const run = (computer: object) =>
    withEnv({ PATH: empty, HOME: empty, PI_CODING_AGENT_DIR: path.join(empty, "agent") }, async () => {
      await fs.mkdir(path.join(empty, "agent"), { recursive: true });
      await fs.writeFile(path.join(empty, "agent", "pi-improved.json"), JSON.stringify({ computer }));
      const t = await setup(() => ({ code: 0 }));
      return (await runDoctor(t.pi, t.ctx, undefined, { has: async () => true })).find((c) => c.name === "Desktop");
    });
  assert.equal(await run({ desktop: "off" }), undefined);
  const on = await run({ desktop: "on" });
  assert.equal(on?.ok, false);
  assert.match(on!.detail, /needs: .*hyprctl \(Hyprland\).*hypruse \(uv tool install hypruse\)/);
});

test("a missing subagent extension says how to get it back", () => {
  assert.match(extensionDetail(undefined), /Run `npm install` in the package folder/);
  assert.equal(extensionDetail("bundled"), "bundled");
});
