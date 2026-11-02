import assert from "node:assert/strict";
import { test } from "node:test";
import { agentlintCheck } from "../src/discover.ts";
import { registerGate } from "../src/gate.ts";
import { updateManifest } from "../src/manifest.ts";
import { registerTask } from "../src/task.ts";
import { registerSetup } from "../src/setup.ts";
import { readTask, writeTask } from "../src/task-state.ts";
import { fakeCtx, fakePi, fakeUI, tempProject } from "./helpers.ts";

const FEATURE = "# Search\n\n## Sub-features\n- a\n\n## How to get to it (user POV)\n- b\n\n## Driving it with browser\n- c\n\n## Gotchas\n- d\n";
const VERIFY_APP = {
  ".pi/skills/verify-app/SKILL.md": "---\nname: verify-app\ndescription: Drive the app\n---\n# Verify\n",
  ".pi/skills/verify-app/features/README.md": "# Features\n",
  ".pi/skills/verify-app/features/search.md": FEATURE,
  ".pi/skills/verify-app/features/coverage.json": JSON.stringify({ sync: "a".repeat(40), paths: ["AGENTS.md"] }),
};
const ASK = "The verify steps changed during the task. Use the new ones?";

/** An implementing task that saved `saved` (none: a task from before the list was saved), and a manifest whose steps are now `verify`. */
async function setup(opts: { saved?: string[]; verify: string[]; answers?: unknown[]; hasUI?: boolean; pass?: boolean; extra?: object }) {
  const task = { id: "t1", title: "Do it", status: "implementing", allowedExtra: [], startedAt: "2026-10-01T00:00:00.000Z", ...(opts.saved && { savedVerify: opts.saved }) };
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: opts.verify, connectors: [], understanding: "off", limits: { verifyRetries: 1, failuresBeforeEscalation: 9 }, ...opts.extra }),
    ".pi/task.json": JSON.stringify(task),
  });
  let diff = "";
  const ran: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git") return { code: 0, stdout: args[0] === "diff" ? diff : "" };
    ran.push(args[1]);
    return opts.pass === false ? { code: 1, stdout: "Error: boom" } : { code: 0 };
  });
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const ui = fakeUI(opts.answers ?? []);
  const ctx: any = { cwd: root, hasUI: opts.hasUI ?? true, ui };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  diff = "changed";
  let n = 0;
  // Each settle sees a new tree, as after the agent's next fix.
  const settle = () => ((diff = `changed ${n++}`), h.emit("agent_before_settle", { outcome: "completed" }, ctx));
  return { root, ui, ran, settle, task: () => readTask(root) };
}

test("TUI: Use the new ones saves the new steps and runs them", async () => {
  const t = await setup({ saved: ["check"], verify: ["check --weaker"], answers: ["Use the new ones", true] });
  await t.settle();
  assert.deepEqual(t.ui.asked, [ASK, "Verification OK"]);
  assert.deepEqual(t.ran, ["check --weaker"]);
  assert.deepEqual((await t.task())?.savedVerify, ["check --weaker"]);
});

test("TUI: Keep the old ones runs the saved steps and tells the agent to put them back", async () => {
  const t = await setup({ saved: ["check"], verify: ["check --weaker"], answers: ["Keep the old ones"] });
  const result: any = await t.settle();
  assert.deepEqual(t.ui.asked, [ASK]);
  assert.deepEqual(t.ran, ["check"]);
  assert.equal(result.continue, true);
  assert.match(result.entries[0].content, /started with \(`check`\): put them back in \.pi\/workflow\.json\./);
  // The task does not close on the old steps while the file still holds the new ones.
  assert.equal((await t.task())?.status, "implementing");
  assert.deepEqual((await t.task())?.savedVerify, ["check"]);
});

test("headless: changed steps do not run, count as a failure, and end red when they stay changed", async () => {
  const t = await setup({ saved: ["check"], verify: ["true"], hasUI: false });
  const [error, code] = [console.error, process.exitCode];
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const first: any = await t.settle();
    assert.equal(first.continue, true);
    assert.match(first.entries[0].content, /verify steps changed during the task[\s\S]*Put back the steps[\s\S]*- check/);
    assert.equal(await t.settle(), undefined);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(lines, ["[pi-improved] Verify failed 2 times. The task stays open: /task done closes it."]);
  } finally {
    console.error = error;
    process.exitCode = code;
  }
  assert.deepEqual(t.ran, []);
  assert.equal((await t.task())?.status, "implementing");
});

test("a step pi-improved adds itself refreshes the saved list instead of asking", async () => {
  const step = agentlintCheck("agentlint");
  const t = await setup({ saved: ["check"], verify: ["check"], answers: [true], extra: { agentlint: "agentlint" } });
  await t.settle();
  assert.deepEqual(t.ui.asked, ["Verification OK"]);
  assert.deepEqual(t.ran, [step, "check"]);
  assert.deepEqual((await t.task())?.savedVerify, [step, "check"]);
});

test("a task saved before the list existed saves it at its first gate without asking", async () => {
  const t = await setup({ verify: ["check"], answers: [true] });
  await t.settle();
  assert.deepEqual(t.ui.asked, ["Verification OK"]);
  assert.deepEqual((await t.task())?.savedVerify, ["check"]);
});

test("/task saves the verify steps when the task starts", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void ((m.setup = "done"), (m.verify = ["check", "lint"])));
  const h = fakePi();
  registerTask(h.pi);
  await h.commands.get("task").handler("Add fee", fakeCtx(root, []).ctx);
  assert.deepEqual((await readTask(root))?.savedVerify, ["check", "lint"]);
});

test("setup_finish refreshes the active task's saved list with the steps it writes", async () => {
  const root = await tempProject({ "AGENTS.md": "# App\n", "GLOSSARY.md": "# G\n", ".pi/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing rules\n---\n# Billing\n", ...VERIFY_APP });
  await updateManifest(root, (m) => void ((m.setup = "running"), (m.verify = ["old"])));
  await writeTask(root, { id: "t1", title: "Do it", status: "implementing", allowedExtra: [], savedVerify: ["old"], startedAt: "2026-10-01T00:00:00.000Z" });
  const h = fakePi();
  registerSetup(h.pi);
  await h.tools.get("setup_finish").execute("1", { verify: ["new"], summary: "s" }, undefined, undefined, fakeCtx(root, [true]).ctx);
  assert.deepEqual((await readTask(root))?.savedVerify, ["new"]);
});
