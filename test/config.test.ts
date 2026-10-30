import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { checkLimits, DEFAULT_LIMITS, globalPath, globalProblem, limitsOf, exists, merge, readGlobal, resolveLimits, updateGlobal, writeFileAtomic } from "../src/config.ts";
import { registerComputer } from "../src/computer/index.ts";
import { runDoctor } from "../src/doctor.ts";
import { registerGuards } from "../src/guards.ts";
import selfCompact from "../src/self-compact/index.ts";
import extension from "../src/index.ts";
import { registerSetup } from "../src/setup.ts";
import { registerGate } from "../src/gate.ts";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { registerLearn } from "../src/learn.ts";
import { migrateGlobal, migrateLegacy, migrateProject } from "../src/legacy-config.ts";
import { MANIFEST_PATH, patchMap, readManifest, readProjectManifest, understandingOf, updateManifest } from "../src/manifest.ts";
import { registerModels } from "../src/models.ts";
import { planRiskReasons } from "../src/risk.ts";
import { registerSkills } from "../src/skills.ts";
import { setupPrompt } from "../src/setup-prompt.ts";
import { registerTask } from "../src/task.ts";
import { fakeCtx, fakePi, fakeUI, isSubagent, tempDir, tempProject, withEnv } from "./helpers.ts";

const write = (file: string, value: unknown) => fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
/** An agent dir holding `global` as pi-improved.json, for the duration of `run`. */
async function withGlobal<T>(global: unknown, run: (dir: string) => Promise<T>) {
  const dir = await tempDir("pi-improved-agent-");
  if (global !== undefined) await write(path.join(dir, "pi-improved.json"), global);
  return withEnv({ PI_CODING_AGENT_DIR: dir }, () => run(dir));
}

test("merge: objects go key by key, arrays and scalars are replaced, __proto__ is skipped", () => {
  const out = merge({ a: { x: 1, y: [1, 2] }, b: 1 }, JSON.parse('{"a":{"y":[3],"z":true},"b":{"c":1},"__proto__":{"polluted":1}}'));
  assert.deepEqual(out, { a: { x: 1, y: [3], z: true }, b: { c: 1 } });
  assert.equal(({} as any).polluted, undefined);
  assert.equal(merge({ a: 1 }, { a: undefined }).a, undefined);
});

test("readManifest: the project wins over the global file, plain objects merge deeply", async () => {
  const global = { mode: "flow", maxReport: 900, models: { implement: "a/cheap", review: "a/strong" }, review: { paths: ["src/**"], minLevel: "low" }, skills: { plan: ["tdd"], review: ["code-review"] }, limits: { retroEvery: 3, fastPath: { files: 4 } } };
  await withGlobal(global, async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["x"], connectors: [], maxReport: 500, models: { review: "b/other" }, review: { paths: ["lib/**"] }, skills: { plan: ["contract-first"] }, limits: { fastPath: { decisions: 1 } } }) });
    const m = await readManifest(root);
    assert.equal(m.mode, "flow", "only the global file sets it");
    assert.equal(m.maxReport, 500, "scalar: project wins");
    assert.deepEqual(m.models, { implement: "a/cheap", review: "b/other" });
    assert.deepEqual(m.review, { paths: ["lib/**"], minLevel: "low" }, "arrays are replaced, not joined");
    assert.deepEqual(m.skills, { plan: ["contract-first"], review: ["code-review"] });
    assert.deepEqual(m.limits, { retroEvery: 3, fastPath: { files: 4, decisions: 1 } });
    assert.deepEqual(limitsOf(m), { ...DEFAULT_LIMITS, retroEvery: 3, fastPath: { files: 4, interface: 6, decisions: 1 } });
  });
});

test("understanding: the global file sets it, the project file overrides it, and a missing or unknown value is plan+end", async () => {
  await withGlobal({ understanding: "end" }, async () => {
    assert.equal(understandingOf(await readManifest(await tempProject({}))), "end");
    assert.equal(understandingOf(await readManifest(await tempProject({ ".pi/workflow.json": JSON.stringify({ understanding: "off" }) }))), "off");
  });
  assert.equal(understandingOf({}), "plan+end");
  assert.equal(understandingOf({ understanding: "always" }), "plan+end");
});

test("readManifest: an old setup with agentlint only inside a script gets the standard step added, recorded and saved once", async () => {
  await withGlobal(undefined, async () => {
    const old = { version: 1, setup: "done", verify: ["npm run lint"], connectors: [], agentlint: "npm exec agentlint --" };
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify(old), "package.json": JSON.stringify({ scripts: { lint: "eslint . && npm exec agentlint -- check --all" } }) });
    const m = await readManifest(root);
    assert.deepEqual(m.verify, ["npm run lint", "npm exec --package=@aurelienbbn/agentlint -- agentlint check --all"], "the legacy npm command is read as the package-named one");
    assert.equal(m.agentlintStep, "npm exec --package=@aurelienbbn/agentlint -- agentlint check --all");
    const saved = await readProjectManifest(root);
    assert.deepEqual([saved.verify, saved.agentlintStep], [m.verify, m.agentlintStep]);
    assert.deepEqual((await readManifest(root)).verify, m.verify, "a second read adds nothing");
    // Opted out, without agentlint, or setup not finished: nothing changes.
    for (const other of [{ ...old, useAgentlint: "never" }, { ...old, agentlint: undefined }, { ...old, setup: "running" }]) {
      const r = await tempProject({ ".pi/workflow.json": JSON.stringify(other) });
      assert.deepEqual([(await readManifest(r)).agentlintStep, (await readProjectManifest(r)).verify], [undefined, ["npm run lint"]]);
    }
  });
});

test("state keys are project-only: the global file cannot set them", async () => {
  await withGlobal({ setup: "done", verify: ["rm -rf /"], connectors: [{ id: "github" }], language: "English", agentlint: "x", mode: "flow" }, async () => {
    const m = await readManifest(await tempProject({}));
    assert.equal(m.setup, "pending");
    assert.deepEqual([m.verify, m.connectors, m.language, m.agentlint], [[], [], undefined, undefined]);
    assert.equal(m.mode, "flow");
  });
});

test("an unreadable global file is a readable error naming the file; readManifest treats it as empty", async () => {
  await withGlobal("{broken", async (dir) => {
    assert.throws(() => readGlobal(), new RegExp(`${path.join(dir, "pi-improved.json").replaceAll(".", "\\.")} is not valid JSON`));
    assert.match(globalProblem()!, /is not valid JSON/);
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["t"], connectors: [], mode: "flow" }) });
    const m = await readManifest(root);
    assert.deepEqual([m.verify, m.mode], [["t"], "flow"], "the project file still applies");
  });
  await withGlobal("[1]", async () => assert.throws(() => readGlobal(), /is not a JSON object/));
  await withGlobal(undefined, async () => assert.equal(globalProblem(), undefined));
});

test("updateManifest writes the project's own content only, never global values", async () => {
  await withGlobal({ mode: "flow", models: { review: "a/strong" }, limits: { retroEvery: 3 } }, async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["t"], connectors: [], maxReport: 500 }) });
    const returned = await updateManifest(root, (m) => {
      assert.equal(m.mode, undefined, "the callback gets the raw project object");
      assert.equal(m.models, undefined);
      m.language = "English";
    });
    assert.equal(returned.mode, undefined);
    assert.deepEqual(await read(path.join(root, MANIFEST_PATH)), { version: 1, setup: "done", verify: ["t"], connectors: [], maxReport: 500, language: "English" });
    assert.equal((await readManifest(root)).mode, "flow", "and the merged view still has it");
    assert.equal((await readProjectManifest(root)).mode, undefined);
  });
});

test("patchMap applies only the changed keys onto the project's own map", () => {
  const before: Record<string, string> = { a: "1", b: "2" };
  assert.deepEqual(patchMap({ b: "own" }, before, { a: "1", b: "2", c: "3" }), { b: "own", c: "3" });
  assert.deepEqual(patchMap({ b: "own" }, before, { a: "9", b: "2" }), { b: "own", a: "9" });
  assert.equal(patchMap({ a: "1" }, { a: "1" }, {}), undefined);
});

test("/models and /skills keep values from the global file out of the repo", async () => {
  await withGlobal({ models: { review: "openai/gpt-6-astra" }, skills: { review: ["code-review"] } }, async () => {
    const root = await tempProject({});
    const luna = { provider: "openai", id: "gpt-6-luna" };
    const astra = { provider: "openai", id: "gpt-6-astra" };
    const f = fakePi();
    registerModels(f.pi);
    const ui = { ...fakeUI(["openai/gpt-6-luna", "No changes", "No changes", "No changes"]), notify: () => {} };
    await f.commands.get("models").handler("", { cwd: root, ui, modelRegistry: { getAvailable: () => [luna, astra] } });
    assert.deepEqual((await read(path.join(root, MANIFEST_PATH))).models, { setup: "openai/gpt-6-luna" });
    assert.equal((await readManifest(root)).models?.review, "openai/gpt-6-astra");

    const s = fakePi();
    registerSkills(s.pi);
    await s.commands.get("skills").handler("", { cwd: root, ui: fakeUI(["No changes", "· retro", "Done", "No changes", "No changes", "No changes", "No changes"]) });
    assert.deepEqual((await read(path.join(root, MANIFEST_PATH))).skills, { plan: ["tdd", "contract-first", "retro"] });
  });
});

test("limits: defaults are today's numbers, valid values are taken, bad ones fall back and are reported", () => {
  assert.deepEqual(resolveLimits(undefined), { limits: DEFAULT_LIMITS, problems: [] });
  assert.deepEqual(DEFAULT_LIMITS, { interviewQuestions: 12, agentlintRules: 3, verifyRetries: 2, failuresBeforeEscalation: 2, planChecks: 1, retroEvery: 5, verifyEvery: 5, changeCap: 500, fastPath: { files: 8, interface: 6, decisions: 2 } });
  assert.deepEqual(resolveLimits({ planChecks: 0, retroEvery: 0, verifyRetries: 0, verifyEvery: 0, fastPath: { files: 0 } }), {
    limits: { ...DEFAULT_LIMITS, planChecks: 0, retroEvery: 0, verifyRetries: 0, verifyEvery: 0, fastPath: { ...DEFAULT_LIMITS.fastPath, files: 0 } },
    problems: [],
  });
  const bad = resolveLimits({ interviewQuestions: 0, agentlintRules: 2.5, verifyRetries: -1, failuresBeforeEscalation: "2", planChecks: null, retroEvery: -5, verifyEvery: 1.5, fastPath: { files: 1.5, interface: 3, bogus: 1 }, turbo: 1 });
  assert.deepEqual(bad.limits, { ...DEFAULT_LIMITS, fastPath: { ...DEFAULT_LIMITS.fastPath, interface: 3 } });
  assert.equal(bad.problems.length, 10);
  assert.match(bad.problems[0], /^limits\.interviewQuestions must be a whole number >= 1, not 0: ignored$/);
  assert.match(bad.problems.join("\n"), /limits\.fastPath\.bogus is not a known limit[\s\S]*limits\.turbo is not a known limit/);
  assert.equal(resolveLimits("lots").problems.length, 1);
  assert.equal(resolveLimits({ fastPath: 3 }).problems.length, 1);
});

test("/doctor shows the files in effect and reports bad limits and ignored global keys", async () => {
  await withGlobal({ limits: { verifyRetries: -2 }, setup: "done", future: 1 }, async (dir) => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], limits: { retroEvery: 2.5 } }) });
    const ctx: any = { cwd: root, hasUI: true, ui: { notify() {} } };
    const checks = await runDoctor(fakePi(() => ({ code: 0 })).pi, ctx, undefined, { has: async () => true });
    const config = checks.find((c) => c.name === "Config")!;
    assert.match(config.detail, new RegExp(`global ${path.join(dir, "pi-improved.json").replaceAll(".", "\\.")}; project ${path.join(root, MANIFEST_PATH).replaceAll(".", "\\.")}`));
    assert.equal(config.ok, false);
    assert.match(config.detail, /Not read from the global file[^\n]*setup, future/);
    const limits = checks.find((c) => c.name === "Limits")!;
    assert.equal(limits.ok, false);
    assert.match(limits.detail, new RegExp(`${path.join(root, MANIFEST_PATH).replaceAll(".", "\\.")}: limits\\.retroEvery must be a whole number >= 0, not 2\\.5: ignored`));
    assert.match(limits.detail, new RegExp(`${path.join(dir, "pi-improved.json").replaceAll(".", "\\.")}: limits\\.verifyRetries must be a whole number >= 0, not -2`));
  });
  await withGlobal(undefined, async () => {
    const root = await tempProject({});
    const checks = await runDoctor(fakePi(() => ({ code: 0 })).pi, { cwd: root, ui: { notify() {} } } as any, undefined, { has: async () => true });
    assert.match(checks.find((c) => c.name === "Config")!.detail, /global .*pi-improved\.json \(not found\); project .*workflow\.json \(not found\)/);
    assert.equal(checks.some((c) => c.name === "Limits"), false);
  });
});

test("migration: legacy global files are copied once, left untouched, and noticed once", async () => {
  const dir = await tempProject({
    "computer.json": JSON.stringify({ browser: "brave", desktop: "on" }),
    "self-compact.json": JSON.stringify({ default: { notice: "60%" } }),
    "settings.json": JSON.stringify({ subagentPanes: "tern", theme: "dark" }),
  });
  const before = await Promise.all(["computer.json", "self-compact.json", "settings.json"].map((f) => fs.readFile(path.join(dir, f), "utf8")));
  const notices = migrateGlobal(dir);
  assert.equal(notices.length, 3);
  assert.match(notices[0], /Moved computer from computer\.json into .*pi-improved\.json\. computer\.json is no longer read and was left as it was\. Delete computer\.json now: while it is there, removing computer from .*pi-improved\.json copies the old value back\./);
  assert.match(notices[2], /Remove subagentPanes from settings\.json now/);
  assert.deepEqual(readGlobal(dir), { computer: { browser: "brave", desktop: "on" }, selfCompact: { default: { notice: "60%" } }, subagentPanes: "tern" });
  assert.deepEqual(await Promise.all(["computer.json", "self-compact.json", "settings.json"].map((f) => fs.readFile(path.join(dir, f), "utf8"))), before);
  assert.deepEqual(migrateGlobal(dir), [], "the second startup moves and says nothing");
  // After that only the new file is read: a changed legacy file is ignored, and a key already there is never overwritten.
  await write(path.join(dir, "computer.json"), { desktop: "off" });
  assert.deepEqual(migrateGlobal(dir), []);
  assert.equal(readGlobal(dir).computer.desktop, "on");
});

test("migration copies only the keys the global file lacks, and never writes over an unreadable file", async () => {
  const dir = await tempProject({ "pi-improved.json": JSON.stringify({ mode: "flow", computer: { desktop: "off" } }), "computer.json": JSON.stringify({ desktop: "on" }), "self-compact.json": JSON.stringify({ default: { force: "80%" } }) });
  assert.equal(migrateGlobal(dir).length, 1);
  assert.deepEqual(readGlobal(dir), { mode: "flow", computer: { desktop: "off" }, selfCompact: { default: { force: "80%" } } });
  const broken = await tempProject({ "pi-improved.json": "{broken", "computer.json": JSON.stringify({ desktop: "on" }) });
  assert.deepEqual(migrateGlobal(broken), []);
  assert.equal(await fs.readFile(path.join(broken, "pi-improved.json"), "utf8"), "{broken");
  const none = await tempProject({ "settings.json": JSON.stringify({ subagentPanes: 3 }), "computer.json": "[1]" });
  assert.deepEqual(migrateGlobal(none), []);
  await assert.rejects(fs.access(path.join(none, "pi-improved.json")));
});

test("migration: a project's .pi/self-compact.json moves into its workflow.json once, without setup defaults", async () => {
  const root = await tempProject({ ".pi/self-compact.json": JSON.stringify({ models: { "a/b": { force: "70%" } } }) });
  const notices = migrateProject(root);
  assert.match(notices[0], /Moved selfCompact from \.pi\/self-compact\.json into \.pi\/workflow\.json/);
  assert.deepEqual(await read(path.join(root, MANIFEST_PATH)), { selfCompact: { models: { "a/b": { force: "70%" } } } });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".pi/self-compact.json"), "utf8")).models["a/b"].force, "70%");
  assert.deepEqual(migrateProject(root), []);
  const m = await readManifest(root);
  assert.deepEqual([m.setup, m.selfCompact], ["pending", { models: { "a/b": { force: "70%" } } }]);

  const set = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["t"], connectors: [], selfCompact: { default: { notice: "50%" } } }), ".pi/self-compact.json": JSON.stringify({ default: { notice: "70%" } }) });
  assert.deepEqual(migrateProject(set), []);
  assert.equal((await read(path.join(set, MANIFEST_PATH))).selfCompact.default.notice, "50%");
  const invalid = await tempProject({ ".pi/workflow.json": "{broken", ".pi/self-compact.json": "{}" });
  assert.deepEqual(migrateProject(invalid), []);
  assert.equal(await fs.readFile(path.join(invalid, MANIFEST_PATH), "utf8"), "{broken");
});

test("migrateLegacy: global alone without a root, both with one", async () => {
  const dir = await tempProject({ "computer.json": JSON.stringify({ desktop: "on" }) });
  const root = await tempProject({ ".pi/self-compact.json": "{}" });
  assert.equal(migrateLegacy(undefined, dir).length, 1);
  await assert.rejects(fs.access(path.join(root, MANIFEST_PATH)));
  const again = await tempProject({ "computer.json": JSON.stringify({ desktop: "on" }) });
  assert.equal(migrateLegacy(root, again).length, 2);
});

test("the setup prompt uses the configured interview and agentlint numbers, and today's by default", async () => {
  const found: any = {};
  const base: any = { version: 1, setup: "running", verify: [], connectors: [], language: "English", agentlint: "pnpm agentlint" };
  const text = setupPrompt(found, base, false);
  assert.match(text, /max ~12 questions/);
  assert.match(text, /at most 3 to start/);
  const custom = setupPrompt(found, { ...base, limits: { interviewQuestions: 5, agentlintRules: 1 } }, false);
  assert.match(custom, /max ~5 questions/);
  assert.match(custom, /at most 1 to start/);
  assert.match(setupPrompt(found, { ...base, limits: { interviewQuestions: 0 } }, false), /max ~12 questions/);
});

test("the fast path takes its sizes from limits.fastPath", () => {
  const plan = (files: number, iface: number, decisions: number) => ({ files: Array.from({ length: files }, (_, i) => `src/f${i}.ts`), interface: new Array(iface).fill({}), decisions: new Array(decisions).fill({}) });
  const m = (limits?: object): any => ({ version: 1, setup: "done", verify: [], connectors: [], limits });
  assert.deepEqual(planRiskReasons(plan(8, 6, 2), m()), []);
  assert.match(planRiskReasons(plan(9, 0, 0), m())[0], /9 files/);
  assert.deepEqual(planRiskReasons(plan(9, 7, 3), m({ fastPath: { files: 9, interface: 7, decisions: 3 } })), []);
  assert.match(planRiskReasons(plan(3, 0, 0), m({ fastPath: { files: 2 } }))[0], /3 files/);
  assert.match(planRiskReasons(plan(1, 0, 1), m({ fastPath: { decisions: 0 } }))[0], /1 decisions/);
  assert.match(planRiskReasons(plan(9, 0, 0), m({ fastPath: { files: -1 } }))[0], /9 files/, "a bad value is the default");
});

test("verifyRetries and failuresBeforeEscalation drive the gate", async () => {
  const run = async (limits: object, settles: number) => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models: { escalate: "p/strong" }, limits }) });
    const h = fakePi((cmd, args) => (cmd === "git" ? { code: 0, stdout: args[0] === "diff" ? "changed" : "" } : { code: 1, stdout: "boom" }));
    h.pi.events = { emit() {} };
    h.pi.setModel = async () => true;
    h.pi.getThinkingLevel = () => "off";
    registerGate(h.pi);
    const ui = fakeUI(["Leave it as is"]);
    const ctx: any = { cwd: root, hasUI: true, ui, model: { provider: "p", id: "cheap" }, modelRegistry: { find: () => ({ provider: "p", id: "strong" }) } };
    await h.emit("before_agent_start", { messageType: "user" }, ctx);
    await h.emit("tool_result", { toolName: "write" }, ctx);
    const results = [];
    for (let i = 0; i < settles; i++) results.push(await h.emit("agent_before_settle", { outcome: "completed" }, ctx));
    return { results, asked: ui.asked };
  };
  const none = await run({ verifyRetries: 0 }, 1);
  assert.equal(none.results[0], undefined, "no retries: it asks at once and the answer stops it");
  assert.equal(none.asked.length, 1);
  const more = await run({ verifyRetries: 3, failuresBeforeEscalation: 3 }, 3);
  assert.deepEqual(more.results.map((r: any) => r.entries[0].customType), ["verify-gate", "verify-gate", "verify-diagnose"], "the third failure diagnoses");
  assert.equal(more.asked.length, 0);
});

test("planChecks sets the paid plan checks per task; 0 turns them off", async () => {
  const run = async (limits: object, calls: number) => {
    const spawns: string[] = [];
    const h = fakePi((cmd, args) => {
      if (!isSubagent(cmd)) return { code: 0 };
      if (args[0] === "spawn") return spawns.push("x"), { code: 0, stdout: "Spawned plan-check (abc)\n" };
      if (args[0] === "wait") return { code: 0, stdout: "abc finished\n\nVERDICT: FIX\n1. rename" };
      return { code: 0 };
    });
    h.pi.events = { emit() {} };
    registerTask(h.pi);
    const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
    await updateManifest(root, (m) => {
      m.setup = "done";
      m.models = { review: "openai/gpt-6-astra" };
      m.review = { plan: true, always: true };
      m.limits = limits;
    });
    await h.commands.get("task").handler("Add fee", fakeCtx(root, []).ctx);
    const plan = { summary: "s", intent: "i", steps: ["a"], files: ["src/fee.ts"], decisions: [], interface: [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(1)", source: "ticket" }], seams: [] };
    for (let i = 0; i < calls; i++) await h.tools.get("task_plan").execute("1", plan, undefined, undefined, fakeCtx(root, [true]).ctx).catch(() => {});
    return spawns.length;
  };
  assert.equal(await run({}, 3), 1, "default: one check per task");
  assert.equal(await run({ planChecks: 2 }, 3), 2);
  assert.equal(await run({ planChecks: 0 }, 3), 0);
});

test("retroEvery sets the retro cadence; 0 turns it off", async () => {
  const run = async (limits: object | undefined, tasks: number) => {
    const root = await tempProject({});
    if (limits) await updateManifest(root, (m) => void (m.limits = limits));
    const f = fakePi(() => ({ code: 0 }));
    const listeners = new Map<string, (d: unknown) => unknown>();
    f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
    registerLearn(f.pi);
    for (let i = 1; i <= tasks; i++) await listeners.get(TASK_DONE_EVENT)!({ root, hasUI: true, task: { id: `T-${i}`, title: "T", status: "done", allowedExtra: [], startedAt: "", plan: { summary: "S", steps: [], files: ["a.ts"], interface: [], seams: [], decisions: [] } } });
    return f.sent;
  };
  assert.equal((await run(undefined, 5)).length, 1);
  const every2 = await run({ retroEvery: 2 }, 5);
  assert.equal(every2.length, 2);
  assert.match(every2[0], /Retro: 2 tasks[\s\S]*last 2 records/);
  assert.equal((await run({ retroEvery: 0 }, 10)).length, 0);
  assert.equal((await run({ retroEvery: -1 }, 5)).length, 1, "a bad value is the default");
});

test("at startup /computer moves computer.json once and says so on the first session with a UI", async () => {
  const dir = await tempProject({ "computer.json": JSON.stringify({ desktop: "off" }) });
  await withEnv({ PI_CODING_AGENT_DIR: dir }, async () => {
    const h = fakePi();
    await registerComputer(h.pi);
    assert.deepEqual(readGlobal(dir), { computer: { desktop: "off" } });
    const notes: string[] = [];
    const ctx: any = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
    await h.emit("session_start", {}, ctx);
    await h.emit("session_start", {}, ctx);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Moved computer from computer\.json into .*pi-improved\.json\. computer\.json is no longer read/);
    const again = fakePi();
    await registerComputer(again.pi);
    await again.emit("session_start", {}, ctx);
    assert.equal(notes.length, 1, "the next startup says nothing");
  });
});

test("/setup builds its prompt from the merged view: global interview numbers and mode apply, and mode is not pinned in the project file", async () => {
  await withGlobal({ mode: "flow", limits: { interviewQuestions: 5, agentlintRules: 1 } }, async () => {
    const root = await tempProject({ "package.json": "{}", "pnpm-lock.yaml": "" });
    const { pi, commands, sent } = fakePi();
    registerSetup(pi);
    await commands.get("setup").handler("", fakeCtx(root, ["Español", "No more", "Yes (recommended)"], { mode: "tui", reload: async () => {} }).ctx);
    assert.match(sent[0], /max ~5 questions/);
    assert.match(sent[0], /at most 1 to start/);
    const own = await read(path.join(root, MANIFEST_PATH));
    assert.equal(own.mode, undefined, "the global mode is not copied into the repo");
    assert.equal(own.limits, undefined);
    assert.equal((await readManifest(root)).mode, "flow");
  });
  await withGlobal(undefined, async () => {
    const root = await tempProject({ "package.json": "{}" });
    const { pi, commands } = fakePi();
    registerSetup(pi);
    await commands.get("setup").handler("", fakeCtx(root, ["Español", "No more", "No"], { mode: "tui", reload: async () => {} }).ctx);
    assert.equal((await read(path.join(root, MANIFEST_PATH))).mode, "direct", "with no mode anywhere it is pinned to direct, as before");
  });
});

test("a broken global file does not switch off the gate: verify still runs, and the session start says why once", async () => {
  await withGlobal("{broken", async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [] }) });
    const ran: string[] = [];
    const h = fakePi((cmd, args) => {
      if (cmd === "git") return { code: 0, stdout: args[0] === "diff" ? "changed" : "" };
      ran.push([cmd, ...args].join(" "));
      return { code: 1, stdout: "boom" };
    });
    h.pi.events = { emit() {} };
    registerGate(h.pi);
    const ctx: any = { cwd: root, hasUI: true, ui: fakeUI([]), model: { provider: "p", id: "m" } };
    await h.emit("before_agent_start", { messageType: "user" }, ctx);
    await h.emit("tool_result", { toolName: "write" }, ctx);
    const result: any = await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
    assert.equal(result.entries[0].customType, "verify-gate");
    assert.ok(ran.length > 0, "the verify command ran");
  });
  await withGlobal("{broken", async (dir) => {
    const { pi, emit } = fakePi();
    const agent = await tempProject({ "extensions/subagent/index.ts": "export default () => {}" });
    await withEnv({ PI_SUBAGENT_RUN_DIR: undefined, PI_CODING_AGENT_DIR: dir }, async () => {
      await fs.cp(path.join(agent, "extensions"), path.join(dir, "extensions"), { recursive: true });
      await extension(pi);
      const notes: string[] = [];
      const ctx: any = { cwd: await tempProject({}), hasUI: true, ui: { notify: (text: string) => void notes.push(text) } };
      await emit("session_start", { reason: "startup" }, ctx);
      const said = notes.filter((n) => /is not valid JSON/.test(n));
      assert.equal(said.length, 1);
      assert.match(said[0], /pi-improved\.json is not valid JSON.*ignored until fixed.*\.pi\/workflow\.json/);
    });
  });
});

test("/doctor keeps failing on a broken global file and reports project-only keys set in a project file", async () => {
  await withGlobal("{broken", async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], computer: { desktop: "on" }, subagentPanes: "tern" }) });
    const checks = await runDoctor(fakePi(() => ({ code: 0 })).pi, { cwd: root, ui: { notify() {} } } as any, undefined, { has: async () => true });
    const config = checks.find((c) => c.name === "Config")!;
    assert.equal(config.ok, false);
    assert.match(config.detail, /pi-improved\.json is not valid JSON.*ignored until it is fixed/);
    assert.match(config.detail, /workflow\.json sets computer, subagentPanes: ignored, these are read from the global file only/);
  });
});

test("an invalid limits value is dropped per file: a bad project value falls back to the global value, not the default", async () => {
  assert.deepEqual(checkLimits({ retroEvery: 2, verifyRetries: -1, fastPath: { files: 3, interface: "x" } }).valid, { retroEvery: 2, fastPath: { files: 3 } });
  await withGlobal({ limits: { retroEvery: 9, verifyRetries: 4, fastPath: { files: 20 } } }, async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], limits: { retroEvery: "often", verifyRetries: 1, fastPath: { files: 1.5, decisions: 0 } } }) });
    const limits = limitsOf(await readManifest(root));
    assert.deepEqual([limits.retroEvery, limits.verifyRetries], [9, 1]);
    assert.deepEqual(limits.fastPath, { files: 20, interface: 6, decisions: 0 });
  });
  await withGlobal({ limits: { retroEvery: -3 } }, async () => {
    assert.equal(limitsOf(await readManifest(await tempProject({}))).retroEvery, 5, "a bad global value falls back to the default");
  });
});

test("choosing the session model for a phase only the global file sets stores an explicit null that unsets it", async () => {
  await withGlobal({ models: { review: "openai/gpt-6-astra", setup: "openai/gpt-6-luna" }, skills: { plan: ["retro"] }, skillsOnDemand: { plan: ["how"] } }, async () => {
    const root = await tempProject({});
    const luna = { provider: "openai", id: "gpt-6-luna" };
    const astra = { provider: "openai", id: "gpt-6-astra" };
    const f = fakePi();
    registerModels(f.pi);
    // Review goes back to the session model; every other phase keeps what it has.
    const ui = { ...fakeUI([]), select: async (title: string): Promise<string> => (/^Review/.test(title) ? "Use the session model" : "No changes") };
    await f.commands.get("models").handler("", { cwd: root, ui, modelRegistry: { getAvailable: () => [luna, astra] } });
    const own = await read(path.join(root, MANIFEST_PATH));
    assert.deepEqual(own.models, { review: null });
    const merged = await readManifest(root);
    assert.deepEqual(merged.models, { setup: "openai/gpt-6-luna" }, "review is unset, the other global model still applies");
    // Picking a model again replaces the null.
    ui.select = async (title: string) => (/^Review/.test(title) ? "openai/gpt-6-luna" : "No changes");
    await f.commands.get("models").handler("", { cwd: root, ui, modelRegistry: { getAvailable: () => [luna, astra] } });
    assert.equal((await read(path.join(root, MANIFEST_PATH))).models.review, "openai/gpt-6-luna");
    // The same for skills: restoring a phase to its defaults while the global file customises it.
    const own2 = patchMap<Record<string, string[]>>(undefined, { plan: ["retro"] }, {}, { plan: ["retro"] });
    assert.deepEqual(own2, { plan: null });
    await updateManifest(root, (m) => void (m.skills = { plan: null } as any));
    assert.equal((await readManifest(root)).skills?.plan, undefined);
    assert.equal((await readManifest(root)).skillsOnDemand?.plan?.[0], "how");
  });
});

test("merge: null in the override unsets a key, at any depth, even when the base has none", () => {
  assert.deepEqual(merge({ a: { x: 1, y: 2 }, b: 1 }, { a: { x: null }, b: null, c: null }), { a: { y: 2 } });
  assert.deepEqual(merge(undefined, { a: { x: null, y: 1 } }), { a: { y: 1 } });
});

test("the model's write and edit tools cannot touch the global config file", async () => {
  await withGlobal({}, async (dir) => {
    const { pi, emit } = fakePi();
    registerGuards(pi);
    const call = (toolName: string, p: string, cwd = "/work/app") => emit("tool_call", { toolName, input: { path: p } }, { cwd });
    const file = path.join(dir, "pi-improved.json");
    for (const toolName of ["write", "edit"]) {
      assert.equal(((await call(toolName, file)) as any)?.block, true, `${toolName} absolute`);
      assert.equal(((await call(toolName, path.relative("/work/app", file))) as any)?.block, true, `${toolName} relative`);
      assert.equal(((await call(toolName, path.join(dir, ".", "x", "..", "pi-improved.json"))) as any)?.block, true, `${toolName} through ./ and ..`);
    }
    assert.equal(await call("write", path.join(dir, "other.json")), undefined);
    assert.equal(await call("write", "/work/app/pi-improved.json"), undefined, "a file of that name elsewhere is not the global config");
    assert.match(((await call("write", file)) as any).reason, /user's own configuration/);
  });
});

test("config files are written through a temp file and renamed: no temp files are left, and a failed write leaves the old file", async () => {
  const dir = await tempDir("pi-improved-agent-");
  updateGlobal((c) => void (c.mode = "flow"), dir);
  updateGlobal((c) => void (c.maxReport = 500), dir);
  assert.deepEqual(readGlobal(dir), { mode: "flow", maxReport: 500 });
  const root = await tempProject({});
  await updateManifest(root, (m) => void (m.language = "English"));
  assert.deepEqual(await fs.readdir(dir), ["pi-improved.json"]);
  assert.deepEqual(await fs.readdir(path.join(root, ".pi")), ["workflow.json"]);
  migrateGlobal(dir);
  assert.deepEqual(await fs.readdir(dir), ["pi-improved.json"]);
  // A private file stays private, and a new one starts private.
  const priv = path.join(dir, "pi-improved.json");
  await fs.chmod(priv, 0o600);
  updateGlobal((c) => void (c.mode = "plan"), dir);
  assert.equal((await fs.stat(priv)).mode & 0o777, 0o600);
  await fs.chmod(priv, 0o640);
  await updateManifest(root, (m) => void (m.language = "Spanish"));
  updateGlobal((c) => void (c.mode = "flow"), dir);
  assert.equal((await fs.stat(priv)).mode & 0o777, 0o640, "an existing mode is kept");
  const fresh = path.join(await tempDir(), "x.json");
  writeFileAtomic(fresh, "{}");
  assert.equal((await fs.stat(fresh)).mode & 0o777, 0o600);
  // A target that cannot be replaced (a directory) fails, and the temp file is cleaned up.
  const blocked = await tempDir();
  await fs.mkdir(path.join(blocked, "pi-improved.json"));
  assert.throws(() => writeFileAtomic(path.join(blocked, "pi-improved.json"), "{}"));
  assert.deepEqual(await fs.readdir(blocked), ["pi-improved.json"]);
});

test("selfCompact: the project's values win over the global ones per model, and --compact-* flags win over both", async () => {
  await withGlobal({ selfCompact: { default: { notice: "100k", warning: "120k" }, models: { "p/m": { force: "150k" } } } }, async () => {
    const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], selfCompact: { default: { notice: "60k" } } }) });
    const info = async (flags: Record<string, string>) => {
      const { pi, emit, commands } = fakePi();
      pi.registerFlag = () => {};
      pi.getFlag = (name: string) => flags[name];
      selfCompact(pi);
      const notes: string[] = [];
      const ctx: any = {
        cwd: root,
        hasUI: true,
        model: { provider: "p", id: "m", contextWindow: 1_000_000 },
        getContextUsage: () => ({ tokens: 1000, contextWindow: 1_000_000 }),
        ui: { notify: (text: string) => void notes.push(text), setFooter() {}, setWidget() {}, setStatus() {} },
      };
      await emit("session_start", { reason: "startup" }, ctx);
      await commands.get("self-compact-info").handler("", ctx);
      return notes.join("\n");
    };
    const files = await info({});
    assert.match(files, /Notice 60,000, warning 120,000, force 150,000 tokens/, "project notice, global warning and per-model force");
    const flagged = await info({ "compact-warning": "130k", "compact-notice": "70k" });
    assert.match(flagged, /Notice 70,000, warning 130,000, force 150,000 tokens/, "flags beat the files");
  });
});

test("exists is false for a missing path or parent and throws on other errors", async () => {
  const dir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "pi-exists-"));
  await fs.writeFile(path.join(dir, "file"), "");
  assert.equal(await exists(path.join(dir, "file")), true);
  assert.equal(await exists(path.join(dir, "missing")), false);
  assert.equal(await exists(path.join(dir, "file", "child")), false);
  await fs.symlink("loop", path.join(dir, "loop"));
  await assert.rejects(exists(path.join(dir, "loop")), { code: "ELOOP" });
});

test("a legacy npx agentlint command is read as the package-named one; other commands are kept", async () => {
  const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, agentlint: "npx agentlint", verify: ["npx agentlint check --all", "npx agentlint-x", "pnpm agentlint check"] }) });
  const m = await readProjectManifest(root);
  const cmd = "npm exec --package=@aurelienbbn/agentlint -- agentlint";
  assert.deepEqual([m.agentlint, m.verify], [cmd, [`${cmd} check --all`, "npx agentlint-x", "pnpm agentlint check"]]);
});
