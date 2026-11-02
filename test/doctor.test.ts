import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionDetail, nodeOk, registerDoctor, runDoctor, shortPath, type NixProbe } from "../src/doctor.ts";
import { fakePi, tempProject, withEnv } from "./helpers.ts";

const models = [{ provider: "anthropic", id: "opus" }];
const setup = async (exec: (cmd: string, args: string[]) => any, hasUI = true, mode?: string, extra = {}, nix: NixProbe = { has: async () => true, resolve: async (attr) => `/nix/store/x-${attr}` }) => {
  const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], mode, models: { implement: "anthropic/opus", review: "openai/gpt-5" }, ...extra }) });
  const notes: { msg: string; level: string }[] = [];
  const status: (string | undefined)[] = [];
  const ctx: any = { cwd: root, hasUI, modelRegistry: { getAvailable: () => models }, ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), setStatus: (key: string, text?: string) => key === "doctor" && status.push(text) } };
  const h = fakePi(exec);
  registerDoctor(h.pi, nix);
  return { ...h, ctx, notes, status };
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

test("/doctor tolerates the legacy mode key: no check, not reported as unknown", async () => {
  for (const mode of ["direct", "turbo"]) {
    const t = await setup(() => ({ code: 0 }), true, mode);
    await t.commands.get("doctor").handler("", t.ctx);
    assert.doesNotMatch(t.notes[0].msg, /mode/, mode);
  }
});

test("/doctor flags option values the code would read as another value, and unknown skills", async () => {
  const t = await setup(() => ({ code: 0 }), true, undefined, { review: { minLevel: "medium" }, useAgentlint: "Never", useBend: "never", understanding: "plan", skills: { plan: ["no-such-skill"], review: "pstack-review" } });
  await t.commands.get("doctor").handler("", t.ctx);
  const msg = t.notes[0].msg;
  assert.match(msg, /✗ Settings: [^\n]*workflow\.json: review\.minLevel: "medium" is not valid: use "off", "low" or "high"/);
  assert.match(msg, /workflow\.json: useAgentlint: "Never" is not valid/);
  assert.doesNotMatch(msg, /useBend/);
  assert.match(msg, /workflow\.json: understanding: "plan" is not valid: use "off", "end" or "plan\+end"/);
  assert.match(msg, /✗ Skills: skills\.plan: unknown skill "no-such-skill"; skills\.review is not a list/);
});

test("/doctor checks types and ranges in both files and names unknown project keys", async () => {
  const empty = await tempProject({});
  await withEnv({ PI_CODING_AGENT_DIR: path.join(empty, "agent") }, async () => {
    await fs.mkdir(path.join(empty, "agent"), { recursive: true });
    await fs.writeFile(path.join(empty, "agent", "pi-improved.json"), JSON.stringify({ maxReport: 100, models: { review: "gpt-5" }, subagentPanes: "Tern" }));
    const t = await setup(() => ({ code: 0 }), true, undefined, { basePrompt: "false", modles: {}, review: { highLines: "800", typo: true }, selfCompact: { default: { bogus: 1 } }, models: { implement: null } });
    await t.commands.get("doctor").handler("", t.ctx);
    const settings = t.notes[0].msg.split("\n").find((l) => l.startsWith("✗ Settings"))!;
    assert.match(settings, /pi-improved\.json: maxReport: must be a number >= 200, not 100/);
    assert.match(settings, /pi-improved\.json: models\.review: must be "provider\/model-id", not "gpt-5"/);
    assert.match(settings, /pi-improved\.json: subagentPanes: "Tern" is not valid: use "tern"/);
    assert.match(settings, /workflow\.json: basePrompt: "false" is not valid: use true or false/);
    assert.match(settings, /workflow\.json: review\.highLines: must be a number >= 0, not "800"/);
    assert.match(settings, /workflow\.json: review\.typo is not a known key/);
    assert.match(settings, /workflow\.json: selfCompact: Unknown setting default\.bogus/);
    assert.doesNotMatch(settings, /implement/, "null unsets a value");
    assert.match(t.notes[0].msg, /✗ Config: [^\n]*Not read from the project file \(unknown keys\): modles/);
  });
  const fine = await setup(() => ({ code: 0 }), true, undefined, { basePrompt: false, maxReport: 500, review: { paths: ["db/**"], minLevel: "low" }, declinedConnectors: ["linear"], agentlintDeclined: true });
  await fine.commands.get("doctor").handler("", fine.ctx);
  assert.doesNotMatch(fine.notes[0].msg, /Settings|unknown keys/);
});

test("/doctor names a skill phase the code does not know", async () => {
  const t = await setup(() => ({ code: 0 }), true, undefined, { skills: { implemnt: ["tdd"] } });
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.notes[0].msg, /skills\.implemnt is not a known phase: use "setup", "plan", "implement", "diagnose", "review" or "learn"/);
});

test("/doctor reports a model id that is not a string instead of throwing", async () => {
  const t = await setup(() => ({ code: 0 }), true, undefined, { models: { review: 123 } });
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.notes[0].msg, /models\.review: must be "provider\/model-id", not 123/);
});

test("/doctor shows a status while it runs and clears it after, even when a check throws", async () => {
  const t = await setup(() => ({ code: 0 }));
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.status[0]!, /checking.*first run downloads.*minutes/);
  assert.equal(t.status.at(-1), undefined);
  const broken = await setup(() => ({ code: 0 }), true, undefined, {}, { has: async () => { throw new Error("boom"); } });
  await assert.rejects(broken.commands.get("doctor").handler("", broken.ctx), /boom/);
  assert.deepEqual([broken.status.length, broken.status.at(-1)], [2, undefined]);
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

test("/doctor says to rename or remove an unknown key, naming the file by its path in the project", async () => {
  const t = await setup(() => ({ code: 0 }), true, undefined, { modles: {}, review: { typo: true } });
  await t.commands.get("doctor").handler("", t.ctx);
  const msg = t.notes[0].msg;
  assert.match(msg, /✗ Config: [^\n]*unknown keys\): modles\. Rename or remove them in \.pi\/workflow\.json/);
  assert.match(msg, /✗ Settings: \.pi\/workflow\.json: review\.typo is not a known key: rename or remove it/);
  assert.ok(!msg.includes(t.ctx.cwd), "no absolute project path");
});

test("shortPath: relative inside the project, ~ inside home, absolute elsewhere", () => {
  const home = os.homedir();
  assert.equal(shortPath(path.join(home, "p", ".pi", "workflow.json"), path.join(home, "p")), path.join(".pi", "workflow.json"));
  assert.equal(shortPath(path.join(home, ".pi", "agent", "pi-improved.json"), path.join(home, "p")), path.join("~", ".pi", "agent", "pi-improved.json"));
  assert.equal(shortPath("/opt/x/y", path.join(home, "p")), "/opt/x/y");
});

test("/doctor without Nix says the subagent needs Nix first, not npm install", async () => {
  const t = await setup(() => ({ code: 1 }), true, undefined, {}, { has: async () => false, resolve: async () => assert.fail("no Nix to build with") });
  await t.commands.get("doctor").handler("", t.ctx);
  const line = t.notes[0].msg.split("\n").find((l) => l.startsWith("✗ subagent:"))!;
  assert.match(line, /needs? Nix|without Nix/);
  assert.doesNotMatch(line, /npm install/);
});
