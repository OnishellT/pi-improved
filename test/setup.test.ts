import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { registerAskUser } from "../src/ask.ts";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { installMessage } from "../src/nix.ts";
import { APPROVE, FIX } from "../src/policy.ts";
import { checkOutputs, registerSetup } from "../src/setup.ts";
import { setupPrompt } from "../src/setup-prompt.ts";
import { fakeCtx, fakePi, fakeUI, tempDir, tempProject, withEnv } from "./helpers.ts";

const SKILL = "---\nname: domain-billing\ndescription: Billing rules\n---\n# Billing\n";
const FEATURE = "# Search\n\n## Sub-features\n- a\n\n## How to get to it (user POV)\n- b\n\n## Driving it with browser\n- c\n\n## Gotchas\n- d\n";
const verifyApp = {
  ".pi/skills/verify-app/SKILL.md": "---\nname: verify-app\ndescription: Drive the app\n---\n# Verify\n",
  ".pi/skills/verify-app/features/README.md": "# Features\n",
  ".pi/skills/verify-app/features/search.md": FEATURE,
  ".pi/skills/verify-app/features/coverage.json": JSON.stringify({ sync: "a".repeat(40), paths: ["AGENTS.md"] }),
};
const exec = fakePi().pi.exec;
const documented = { "AGENTS.md": "# App\n", "GLOSSARY.md": "# G\n", ".pi/skills/domain-billing/SKILL.md": SKILL, "package.json": "{}", ...verifyApp };

const ctxFor = (root: string, answers: unknown[]) => fakeCtx(root, answers, { mode: "tui", reload: async () => {} });

test("checkOutputs reports every missing piece", async () => {
  const root = await tempProject({ "AGENTS.md": "x\n".repeat(200), ".pi/skills/bad/SKILL.md": "# no frontmatter" });
  const problems = await checkOutputs(root, [], exec);
  assert.equal(problems.length, 8);
  assert.deepEqual(await checkOutputs(await tempProject(documented), ["true"], exec), []);
});

test("checkOutputs checks the verification skill: files, the four H2s per feature and the coverage record", async () => {
  const bad = { ...documented, ".pi/skills/verify-app/features/search.md": "# Search\n\n## Sub-features\n## Gotchas\n", ".pi/skills/verify-app/features/coverage.json": "{}" };
  const problems = (await checkOutputs(await tempProject(bad), ["true"], exec)).join("\n");
  assert.match(problems, /search\.md needs these H2 headings: How to get to it \(user POV\); Driving it with <harness>\./);
  assert.match(problems, /coverage\.json must be/);
  assert.doesNotMatch(problems, /README|SKILL\.md/);
  const noGit = fakePi((_cmd, args) => ({ code: args[0] === "cat-file" ? 128 : 0 })).pi.exec;
  assert.match((await checkOutputs(await tempProject(documented), ["true"], noGit)).join("\n"), /sync a{40} is not a commit of this repo/);
  const stale = { ...documented, ".pi/skills/verify-app/features/coverage.json": JSON.stringify({ sync: "a".repeat(40), paths: ["src/"] }) };
  assert.match((await checkOutputs(await tempProject(stale), ["true"], exec)).join("\n"), /these paths do not exist: src\//);
  const { [".pi/skills/verify-app/features/coverage.json"]: _, ...without } = documented;
  assert.match((await checkOutputs(await tempProject(without), ["true"], exec)).join("\n"), /coverage\.json must be/);
});

test("checkOutputs skips the verification skill when setup does not create it", async () => {
  const root = await tempProject({ ...documented, ".pi/skills/verify-app/features/search.md": "# bad\n" });
  await updateManifest(root, (m) => void (m.skills = { setup: ["research"] }));
  assert.deepEqual(await checkOutputs(root, ["true"], exec), []);
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

test("/setup says Nix is missing instead of scanning an empty project", async () => {
  const root = await tempProject({ "package.json": "{}" });
  const { pi, commands, sent } = fakePi(() => ({ code: 127, stderr: installMessage() }));
  registerSetup(pi);
  const { ctx, ui } = ctxFor(root, []);
  const notes: string[] = [];
  (ui as any).notify = (m: string) => void notes.push(m);
  await commands.get("setup").handler("", ctx);
  assert.match(notes[0], /Nix is required and was not found/);
  assert.equal(ui.asked.length, 0);
  assert.equal(sent.length, 0);
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

  await assert.rejects(finish(ctxFor(root, [false]).ctx), /agentlint is not configured/);
  await fs.mkdir(path.join(root, ".agentlint"));
  await fs.writeFile(path.join(root, ".agentlint/config.ts"), "");
  await finish(ctxFor(root, [true]).ctx);

  assert.ok(ran.includes("pnpm agentlint rules test"));
  assert.deepEqual((await readManifest(root)).verify, ["pnpm test", "pnpm agentlint check --all"]);
});

test("useAgentlint skips the agentlint question: never leaves it out, always adds it", async () => {
  for (const [use, expected] of [["never", undefined], ["always", "pnpm agentlint"]]) {
    // "never" also turns off agentlint that an earlier setup chose.
    const workflow = use === "never" ? { useAgentlint: use, agentlint: "pnpm agentlint", agentlintStep: "pnpm agentlint check --all", verify: ["pnpm test", "pnpm agentlint check --all", "pnpm types && pnpm agentlint check --all"] } : { useAgentlint: use };
    const root = await tempProject({ "package.json": "{}", "pnpm-lock.yaml": "", ".pi/workflow.json": JSON.stringify(workflow) });
    const { pi, commands } = fakePi();
    registerSetup(pi);
    const { ctx, ui } = ctxFor(root, ["Español", "No more"]);
    const notes: string[] = [];
    (ui as any).notify = (m: string) => void notes.push(m);
    await commands.get("setup").handler("", ctx);
    assert.equal(ui.asked.length, 2);
    const manifest = await readManifest(root);
    assert.equal(manifest.agentlint, expected);
    // Only the step setup recorded goes with it; a user's own command, compound or not, is never edited.
    if (use === "never") {
      assert.deepEqual(manifest.verify, ["pnpm test", "pnpm types && pnpm agentlint check --all"]);
      assert.equal(manifest.agentlintStep, undefined);
      assert.equal(notes.filter((n: string) => /still runs agentlint/.test(n)).length, 1);
    }
  }
});

test("useAgentlint never also removes the step an older setup added, recognised by its exact text", async () => {
  const workflow = { useAgentlint: "never", agentlint: "pnpm agentlint", verify: ["pnpm test", "pnpm agentlint check --all", "pnpm lint && pnpm agentlint check --all"] };
  const root = await tempProject({ "package.json": "{}", "pnpm-lock.yaml": "", ".pi/workflow.json": JSON.stringify(workflow) });
  const { pi, commands } = fakePi();
  registerSetup(pi);
  const { ctx } = ctxFor(root, ["Español", "No more"]);
  await commands.get("setup").handler("", ctx);
  assert.deepEqual((await readManifest(root)).verify, ["pnpm test", "pnpm lint && pnpm agentlint check --all"]);
});

test("setup_finish offers to drop agentlint when the person turned it down after choosing it", async () => {
  const root = await tempProject(documented);
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "pnpm agentlint";
  });
  const { pi, tools } = fakePi();
  registerSetup(pi);
  const { ctx, ui } = ctxFor(root, [true, true]);
  await tools.get("setup_finish").execute("1", { verify: ["pnpm test"], summary: "s" }, undefined, undefined, ctx);
  assert.equal(ui.asked[0], "Drop agentlint?");
  const manifest = await readManifest(root);
  assert.equal(manifest.agentlint, undefined);
  assert.deepEqual(manifest.verify, ["pnpm test"]);
});

test("setup_finish: agentlint findings in existing code go to the user, one reason each, not back to the model", async () => {
  const run = async (answers: unknown[]) => {
    const root = await tempProject({ ...documented, ".agentlint/config.ts": "" });
    await updateManifest(root, (m) => {
      m.setup = "running";
      m.agentlint = "npm exec agentlint --";
    });
    let open = 1;
    const approved: string[] = [];
    const { pi, tools } = fakePi((_cmd, args) => {
      const script = args.slice(4);
      if (script[0] === "next") return { code: 0, stdout: JSON.stringify(open ? { remaining: 1, selector: "sel", finding: { ruleTitle: "Slug needs ADR", file: "src/slugify.js", line: 2 } } : { remaining: 0 }) };
      if (script[0] === "approve") return approved.push(script[2]), (open = 0), { code: 0 };
      if (/check --all/.test(args[1])) return open ? { code: 1, stdout: "1 unresolved finding — gate closed" } : { code: 0 };
      return { code: 0 };
    });
    registerSetup(pi);
    const { ctx, ui } = ctxFor(root, answers);
    const out = tools.get("setup_finish").execute("1", { verify: ["npm test"], summary: "s" }, undefined, undefined, ctx);
    return { out, ui, approved, root };
  };
  const accepted = await run([APPROVE, "predates ADR 0001", true]);
  await accepted.out;
  assert.deepEqual(accepted.approved, ["predates ADR 0001"]);
  assert.match(accepted.ui.asked[1], /Slug needs ADR\nsrc\/slugify\.js:2/);
  assert.equal((await readManifest(accepted.root)).setup, "done");
  const sentBack = await run([FIX]);
  await assert.rejects(sentBack.out, /make it a `change` rule/);
  assert.deepEqual(sentBack.approved, []);
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

test("setup_finish leaves mode unset in the project when the global file sets it", async () => {
  const root = await tempProject(documented);
  await updateManifest(root, (m) => void (m.setup = "running"));
  const agent = await tempDir();
  await fs.writeFile(path.join(agent, "pi-improved.json"), JSON.stringify({ mode: "flow" }));
  const { pi, tools } = fakePi(() => ({ code: 0 }));
  registerSetup(pi);
  await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => {
    await tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, ctxFor(root, [true]).ctx);
    assert.equal((await readManifest(root)).mode, "flow");
  });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".pi/workflow.json"), "utf8")).mode, undefined);
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
    ...verifyApp,
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

test("setup_finish adds and records its own agentlint step even when a package script already runs agentlint", async () => {
  const root = await tempProject({
    "AGENTS.md": "# App\n",
    "GLOSSARY.md": "# G\n",
    ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing\n---\n",
    ".agentlint/config.ts": "",
    ...verifyApp,
    "package.json": JSON.stringify({ scripts: { verify: "npm test && npm exec agentlint -- check --all" } }),
  });
  await updateManifest(root, (m) => {
    m.setup = "running";
    m.agentlint = "npm exec agentlint --";
  });
  const ran: string[] = [];
  const { pi, tools } = fakePi((cmd, args) => (cmd === "bash" && ran.push(args[1]), { code: 0 }));
  registerSetup(pi);
  await tools.get("setup_finish").execute("1", { verify: ["npm run verify"], summary: "s" }, undefined, undefined, { cwd: root, hasUI: true, ui: fakeUI([true]) });
  const manifest = await readManifest(root);
  assert.deepEqual(manifest.verify, ["npm run verify", "npm exec agentlint -- check --all"]);
  assert.equal(manifest.agentlintStep, "npm exec agentlint -- check --all");
  // Its own step runs first, so a failing script that also runs agentlint cannot stop verify before the per-finding approval.
  assert.deepEqual(ran.filter((c) => manifest.verify.includes(c)), ["npm exec agentlint -- check --all", "npm run verify"]);
});

test("setup_finish refuses outside setup", async () => {
  const root = await tempProject({});
  const { pi, tools } = fakePi();
  registerSetup(pi);
  const { ctx } = ctxFor(root, []);
  await assert.rejects(tools.get("setup_finish").execute("1", { verify: ["true"], summary: "s" }, undefined, undefined, ctx), /No setup is running/);
});

test("a .pi/workflow.json that cannot be read says so; only bad JSON is called invalid", async () => {
  const root = await tempProject({});
  await fs.mkdir(path.join(root, ".pi/workflow.json"), { recursive: true });
  await assert.rejects(readManifest(root), /\.pi\/workflow\.json cannot be read: EISDIR/);
  await fs.rm(path.join(root, ".pi/workflow.json"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi/workflow.json"), "{");
  await assert.rejects(readManifest(root), /\.pi\/workflow\.json is not valid JSON/);
});
