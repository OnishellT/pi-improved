import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { registerAskUser } from "../src/ask.ts";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { checkOutputs, registerSetup } from "../src/setup.ts";
import { setupPrompt } from "../src/setup-prompt.ts";
import { fakeCtx, fakePi, fakeUI, tempProject } from "./helpers.ts";

const SKILL = "---\nname: domain-billing\ndescription: Billing rules\n---\n# Billing\n";
const documented = { "AGENTS.md": "# App\n", "GLOSSARY.md": "# G\n", ".pi/skills/domain-billing/SKILL.md": SKILL, "package.json": "{}" };

const ctxFor = (root: string, answers: unknown[]) => fakeCtx(root, answers, { mode: "tui", reload: async () => {} });

test("checkOutputs reports every missing piece", async () => {
  const root = await tempProject({ "AGENTS.md": "x\n".repeat(200), ".pi/skills/bad/SKILL.md": "# no frontmatter" });
  const problems = await checkOutputs(root, []);
  assert.equal(problems.length, 5);
  assert.deepEqual(await checkOutputs(await tempProject(documented), ["true"]), []);
});

test("/setup runs discovery, asks only about connectors, and hands one prompt to the model", async () => {
  const root = await tempProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
  const { pi, commands, sent, mcp } = fakePi((cmd, args) =>
    args.includes("remote") ? { code: 0, stdout: "origin git@github.com:acme/app.git (fetch)" } : { code: 0 },
  );
  registerSetup(pi);
  const { ctx, ui } = ctxFor(root, ["Español", true, "No more", "No"]);

  await commands.get("setup").handler("", ctx);

  assert.equal(ui.asked.length, 4);
  assert.match(ui.asked[1], /GitHub/);
  const manifest = await readManifest(root);
  assert.equal(manifest.setup, "running");
  assert.deepEqual(manifest.verify, ["npm run test"]);
  assert.deepEqual(manifest.connectors.map((c) => c.id), ["github"]);
  assert.deepEqual(mcp.map((s) => s.name), ["github"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /setup_finish/);
});

test("choosing agentlint adds its steps to the prompt", async () => {
  const root = await tempProject({ "package.json": "{}", "pnpm-lock.yaml": "" });
  const { pi, commands, sent } = fakePi();
  registerSetup(pi);
  await commands.get("setup").handler("", ctxFor(root, ["Español", "No more", "Yes (recommended)"]).ctx);
  assert.equal((await readManifest(root)).agentlint, "pnpm agentlint");
  assert.match(sent[0], /pnpm add -D @aurelienbbn\/agentlint[\s\S]*rule-advisor[\s\S]*NEVER bulk-accept/);
});

test("setup_finish requires the agentlint config and appends its gate to verify", async () => {
  const root = await tempProject(documented);
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "pnpm agentlint";
  });
  const ran: string[] = [];
  const { pi, tools } = fakePi((_cmd, args) => (ran.push(args[1]), { code: 0 }));
  registerSetup(pi);
  const finish = (ctx: any) => tools.get("setup_finish").execute("1", { verify: ["pnpm test"], summary: "s" }, undefined, undefined, ctx);

  await assert.rejects(finish(ctxFor(root, []).ctx), /agentlint is not configured/);
  await fs.mkdir(path.join(root, ".agentlint"));
  await fs.writeFile(path.join(root, ".agentlint/config.ts"), "");
  await finish(ctxFor(root, [true]).ctx);

  assert.ok(ran.includes("pnpm agentlint rules test"));
  assert.deepEqual((await readManifest(root)).verify, ["pnpm test", "pnpm agentlint check --all"]);
});

test("setup_finish rejects incomplete output without asking the user", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void (m.setup = "running"));
  const { pi, tools } = fakePi();
  registerSetup(pi);
  const { ctx } = ctxFor(root, []);
  await assert.rejects(tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, ctx), /AGENTS.md is missing/);
});

test("setup_finish sends verify failures back to the model, then completes after approval", async () => {
  const root = await tempProject(documented);
  await updateManifest(root, (m) => void (m.setup = "running"));
  let failing = true;
  const { pi, tools } = fakePi((cmd, args) => (args[1] === "npm test" && failing ? { code: 1, stderr: "1 test failed" } : { code: 0 }));
  registerSetup(pi);
  const finish = (ctx: any) => tools.get("setup_finish").execute("1", { verify: ["npm test"], summary: "Documented billing." }, undefined, undefined, ctx);

  await assert.rejects(finish(ctxFor(root, []).ctx), /verify FAILED[\s\S]*1 test failed/);
  failing = false;
  const result = await finish(ctxFor(root, [true]).ctx);

  assert.equal(result.terminate, true);
  const manifest = await readManifest(root);
  assert.equal(manifest.setup, "done");
  assert.equal(manifest.mode, "direct");
  assert.deepEqual(manifest.verify, ["npm test"]);
});

test("rejecting the setup returns the user's feedback to the model", async () => {
  const root = await tempProject(documented);
  await updateManifest(root, (m) => void (m.setup = "running"));
  const { pi, tools } = fakePi();
  registerSetup(pi);
  const { ctx } = ctxFor(root, [false, "Falta el dominio de pagos"]);
  await assert.rejects(tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, ctx), /Falta el dominio de pagos/);
  assert.equal((await readManifest(root)).setup, "running");
});

test("the settle hook nudges a model that stops early, a bounded number of times", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void (m.setup = "running"));
  const { pi, emit } = fakePi();
  registerSetup(pi);
  const ctx = { cwd: root };
  const settle = () => emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.equal((await settle())?.continue, true);
  assert.equal((await settle())?.continue, true);
  assert.equal(await settle(), undefined);
  await emit("before_agent_start", { messageType: "user" }, ctx);
  assert.equal((await settle())?.continue, true);
});

test("a run that settles with setup unfinished says how to resume", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void (m.setup = "running"));
  const { pi, emit } = fakePi();
  registerSetup(pi);
  const notes: string[] = [];
  const ctx = { cwd: root, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  await emit("agent_settled", { aborted: true }, ctx);
  assert.match(notes[0], /Run \/setup to continue/);
  await updateManifest(root, (m) => void (m.setup = "done"));
  await emit("agent_settled", { aborted: false }, ctx);
  assert.equal(notes.length, 1);
});

test("ask_user batches questions and supports a free-text answer", async () => {
  const { pi, tools } = fakePi();
  registerAskUser(pi);
  const { ctx } = ctxFor("/", ["Postgres", "✏️  Other answer…", "Equipo de pagos"]);
  const result = await tools.get("ask_user").execute(
    "1",
    { questions: [{ question: "¿Base de datos?", options: ["Postgres", "MySQL"] }, { question: "¿Dueño?", options: ["Core", "Infra"] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details.answers.map((a: any) => a.answer), ["Postgres", "Equipo de pagos"]);
});

test("the startup offer: \"Don't ask again\" declines setup for good, \"Later\" does not, \"Yes\" runs /setup", async () => {
  for (const [choice, declined, sent] of [["Don't ask again", true, 0], ["Later", false, 0], ["Yes", false, 1]] as const) {
    const root = await tempProject({ ".git/HEAD": "ref: refs/heads/main\n" });
    const { pi, emit, sent: messages } = fakePi();
    registerSetup(pi);
    await emit("session_start", { reason: "startup" }, ctxFor(root, [choice]).ctx);
    assert.equal((await readManifest(root)).setup === "declined", declined, choice);
    assert.equal(messages.length, sent, choice);
  }
});
test("setup prompt asks for the before-finishing and /task sections with the verify commands", () => {
  const text = setupPrompt({} as any, { version: 1, setup: "running", verify: ["npm test"], connectors: [], language: "English" }, false);
  assert.match(text, /Before finishing[\s\S]*`npm test`/);
  assert.match(text, /When to use \/task[\s\S]*migrations/);
});

test("the gitignore list covers the state paths their owners define", async () => {
  const { IGNORED_STATE } = await import("../src/setup.ts");
  const { TASK_PATH } = await import("../src/task-state.ts");
  const { CONTRACT_PATH } = await import("../src/contract.ts");
  const { METRICS_DIR } = await import("../src/telemetry.ts");
  for (const owned of [TASK_PATH, CONTRACT_PATH, METRICS_DIR]) assert.ok(IGNORED_STATE.includes(owned), owned);
});

test("an agentlint config with zero rules does not block setup", async () => {
  const root = await tempProject({
    "AGENTS.md": "# App\n",
    "GLOSSARY.md": "# G\n",
    ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing\n---\n",
    ".agentlint/config.ts": "",
  });
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "npm exec agentlint --";
  });
  const { pi, tools } = fakePi((_cmd, args) => (/rules test/.test(args[1]) ? { code: 2, stderr: "No matching rules. Available:" } : { code: 0 }));
  registerSetup(pi);
  const ui = fakeUI([true]);
  const result = await tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, { cwd: root, hasUI: true, ui });
  assert.equal(result.terminate, true);
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /\.pi\/task\.json/);
});

test("setup_finish does not add agentlint twice when a package script already runs it", async () => {
  const root = await tempProject({
    "AGENTS.md": "# App\n",
    "GLOSSARY.md": "# G\n",
    ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing\n---\n",
    ".agentlint/config.ts": "",
    "package.json": JSON.stringify({ scripts: { verify: "npm test && npm exec agentlint -- check --all" } }),
  });
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "npm exec agentlint --";
  });
  const { pi, tools } = fakePi();
  registerSetup(pi);
  await tools.get("setup_finish").execute("1", { verify: ["npm run verify"], summary: "s" }, undefined, undefined, { cwd: root, hasUI: true, ui: fakeUI([true]) });
  assert.deepEqual((await readManifest(root)).verify, ["npm run verify"]);
});

test("setup_finish refuses outside setup", async () => {
  const root = await tempProject({});
  const { pi, tools } = fakePi();
  registerSetup(pi);
  const { ctx } = ctxFor(root, []);
  await assert.rejects(tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, ctx), /No setup is running/);
});
