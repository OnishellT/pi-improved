import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { registerAskUser } from "../src/ask.ts";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { checkOutputs, registerSetup } from "../src/setup.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const SKILL = "---\nname: domain-billing\ndescription: Billing rules\n---\n# Billing\n";
const documented = { "AGENTS.md": "# App\n", ".pi/skills/domain-billing/SKILL.md": SKILL, "package.json": "{}" };

function ctxFor(root: string, answers: unknown[]) {
  const ui = fakeUI(answers);
  return { ui, ctx: { cwd: root, hasUI: true, mode: "tui", ui, waitForIdle: async () => {}, reload: async () => {} } as any };
}

test("checkOutputs reports every missing piece", async () => {
  const root = await tempProject({ "AGENTS.md": "x\n".repeat(200), ".pi/skills/bad/SKILL.md": "# no frontmatter" });
  const problems = await checkOutputs(root, []);
  assert.equal(problems.length, 4);
  assert.deepEqual(await checkOutputs(await tempProject(documented), ["true"]), []);
});

test("/setup runs discovery, asks only about connectors, and hands one prompt to the model", async () => {
  const root = await tempProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
  const { pi, commands, sent, mcp } = fakePi((cmd, args) =>
    args.includes("remote") ? { code: 0, stdout: "origin git@github.com:acme/app.git (fetch)" } : { code: 0 },
  );
  registerSetup(pi);
  const { ctx, ui } = ctxFor(root, ["Español", true, "Ninguno más", "No"]);

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
  await commands.get("setup").handler("", ctxFor(root, ["Español", "Ninguno más", "Sí (recomendado)"]).ctx);
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

test("ask_user batches questions and supports a free-text answer", async () => {
  const { pi, tools } = fakePi();
  registerAskUser(pi);
  const { ctx } = ctxFor("/", ["Postgres", "✏️  Otra respuesta…", "Equipo de pagos"]);
  const result = await tools.get("ask_user").execute(
    "1",
    { questions: [{ question: "¿Base de datos?", options: ["Postgres", "MySQL"] }, { question: "¿Dueño?", options: ["Core", "Infra"] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details.answers.map((a: any) => a.answer), ["Postgres", "Equipo de pagos"]);
});
