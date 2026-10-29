import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { basePromptText } from "../src/base-prompt.ts";
import { findBend, isLaws, LAWS_RULE } from "../src/bend.ts";
import { discover } from "../src/discover.ts";
import { registerDoctor } from "../src/doctor.ts";
import { assessRisk } from "../src/risk.ts";
import { setupPrompt } from "../src/setup-prompt.ts";
import { skillsBlock } from "../src/skills.ts";
import { fakePi, tempDir, tempProject } from "./helpers.ts";

const noGit = async () => "";
/** `bash -lc 'command -v bend'` finds bend: it is on the login shell's PATH, which verify uses. */
const loginBend = async (command: string, args: string[]) => (command === "bash" && args.join(" ") === "-lc command -v bend" ? "/home/u/.bend/bin/bend\n" : "");
const STEP = "BEND_NO_TELEMETRY=1 bend --check-only 'PROOF.bend'";

/** A PATH directory holding an executable named `bend` (or an empty one). */
async function pathWith(installed: boolean) {
  const dir = await tempDir();
  if (installed) {
    await fs.writeFile(path.join(dir, "bend"), "#!/bin/sh\n");
    await fs.chmod(path.join(dir, "bend"), 0o755);
  }
  return dir;
}

test("isLaws matches only LAWS.bend files, at any depth", () => {
  assert.ok(isLaws("LAWS.bend") && isLaws("laws/LAWS.bend") && isLaws("a/b/LAWS.bend"));
  assert.ok(!isLaws("PROOF.bend") && !isLaws("MYLAWS.bend") && !isLaws("LAWS.bend.md"));
});

test("a project without LAWS.bend sees nothing of Bend", async () => {
  const root = await tempProject({ "go.mod": "module x", "PROOF.bend": "" });
  assert.equal(await findBend(root), undefined);
  const found = await discover(root, loginBend);
  assert.equal(found.bend, undefined);
  assert.ok(!found.verify.some((s) => /bend/.test(s)));
  assert.doesNotMatch(setupPrompt(found, { version: 1, setup: "running", verify: found.verify, connectors: [], language: "English", useBend: "never" }, false), /LAWS\.bend|bend-lang/);
  for (const phase of ["plan", "implement"] as const) assert.doesNotMatch(await skillsBlock(root, phase), /bend-laws|LAWS\.bend/);
});

test("LAWS.bend, PROOF.bend and bend on PATH propose the proof check as a verify step", async () => {
  const root = await tempProject({ "pyproject.toml": "[tool.pytest]\n", "LAWS.bend": "", "PROOF.bend": "" });
  const found = await discover(root, loginBend);
  assert.deepEqual(found.bend, { laws: "LAWS.bend", proof: "PROOF.bend", installed: true });
  assert.equal(found.verify.at(-1), STEP);
  assert.match(found.verify[0], /pytest/);
});

test("bend on pi's PATH but not in the login shell is not installed: verify could not run it", async () => {
  const root = await tempProject({ "LAWS.bend": "", "PROOF.bend": "" });
  const found = await discover(root, noGit, await pathWith(true));
  assert.equal(found.bend?.installed, false);
  assert.deepEqual(found.verify, []);
});

test("bend missing: no verify step, and the setup prompt says how to install it without installing", async () => {
  const root = await tempProject({ "LAWS.bend": "", "PROOF.bend": "" });
  const found = await discover(root, noGit);
  assert.equal(found.bend?.installed, false);
  assert.deepEqual(found.verify, []);
  const prompt = setupPrompt(found, { version: 1, setup: "running", verify: [], connectors: [], language: "English" }, false);
  assert.match(prompt, /not on PATH\. Do not install it[\s\S]*bend-lang\.com\/install\.sh/);
});

test("LAWS.bend without PROOF.bend proposes no step (it would fail), and the prompt says so", async () => {
  const found = await discover(await tempProject({ "LAWS.bend": "" }), loginBend);
  assert.deepEqual(found.verify, []);
  assert.match(setupPrompt(found, { version: 1, setup: "running", verify: [], connectors: [], language: "English" }, false), /no `PROOF\.bend` yet/);
});

test("the Bend skill is listed on request for plan and implement only when the project has laws", async () => {
  const root = await tempProject({ "LAWS.bend": "" });
  for (const phase of ["plan", "implement"] as const) {
    assert.match(await skillsBlock(root, phase), /^- bend-laws: .+LAWS\.bend/m);
  }
  assert.doesNotMatch(await skillsBlock(root, "review"), /bend-laws/);
  assert.match(await skillsBlock(root, "implement"), /^Critical logic is verified against the laws in LAWS\.bend.+user's approval\.$/m);
  // The rule does not ride on principles-implement: a project that drops it keeps the rule.
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi/workflow.json"), JSON.stringify({ version: 1, setup: "done", verify: ["true"], connectors: [], language: "English", skills: { implement: [] } }));
  const custom = await skillsBlock(root, "implement");
  assert.doesNotMatch(custom, /Skill: principles-implement/);
  assert.match(custom, /^Critical logic is verified against the laws/m);
});

/** Each row is a changed file with its line count; `added` files are new (`A`), the rest existed (`M`). */
const exec = (rows: [string, number][], added: string[] = []): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? rows.map(([f, n]) => `${n}\t0\t${f}\0`).join("") : args.includes("--name-status") ? rows.map(([f]) => `${added.includes(f) ? "A" : "M"}\0${f}\0`).join("") : args[0] === "rev-list" ? "c".repeat(40) : "",
});
const plan = { summary: "", steps: [], files: [], decisions: [] as any[], interface: [], seams: [] };
const task: any = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "2026-10-01T00:00:00.000Z", plan };
const manifest: any = { version: 1, setup: "done", verify: [], connectors: [], review: { minLevel: "high" } };
const risk = async (e: any) => assessRisk(e, await tempProject({}), task, manifest);

test("editing an existing LAWS.bend is high risk; PROOF.bend, the model and a new LAWS.bend are not", async () => {
  const edited = await risk(exec([["LAWS.bend", 1]]));
  assert.equal(edited.level, "high");
  assert.equal(edited.review, true);
  assert.match(edited.reasons.join(), /laws changed \(LAWS\.bend\)/);
  assert.match((await risk(exec([["laws/LAWS.bend", 1]]))).reasons.join(), /laws\/LAWS\.bend/);
  // The completion dialog lists it whatever the review policy.
  const never = await assessRisk(exec([["LAWS.bend", 1]]), await tempProject({}), task, { ...manifest, review: { never: true } });
  assert.match(never.flagged?.join() ?? "", /Laws changed \(LAWS\.bend\)/);
  for (const e of [exec([["PROOF.bend", 50], ["Risk.bend", 20]]), exec([["LAWS.bend", 5], ["PROOF.bend", 5]], ["LAWS.bend", "PROOF.bend"])]) {
    assert.deepEqual(await risk(e), { review: false, level: "none", reasons: [] });
  }
});

test("a type change to LAWS.bend (a file made a symlink) is flagged like an edit", async () => {
  const typeChange: any = async (_cmd: string, args: string[]) => ({
    code: 0, stderr: "", killed: false,
    stdout: args.includes("--numstat") ? "1\t0\tLAWS.bend\0" : args.includes("--name-status") ? "T\0LAWS.bend\0" : args[0] === "rev-list" ? "c".repeat(40) : "",
  });
  assert.match((await risk(typeChange)).reasons.join(), /laws changed \(LAWS\.bend\)/);
});

test("the main session's prompt gains the laws rule only in a project with LAWS.bend", async () => {
  const plain = await basePromptText(await tempProject({ "a.ts": "" }));
  assert.equal(plain, await basePromptText());
  assert.ok(!plain.includes(LAWS_RULE));
  assert.ok((await basePromptText(await tempProject({ "LAWS.bend": "" }))).endsWith(`\n${LAWS_RULE}`));
});

const doctor = async (files: Record<string, string>, code: number) => {
  const root = await tempProject({ ...files, ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [] }) });
  const notes: string[] = [];
  const ctx: any = { cwd: root, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  const h = fakePi((cmd, args) => (cmd === "bash" && /bend version/.test(args[1]) ? { code, stdout: code ? "" : "bend 2.0.39\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
  registerDoctor(h.pi);
  await h.commands.get("doctor").handler("", ctx);
  return notes[0];
};

test("/doctor reports bend only when LAWS.bend exists", async () => {
  assert.match(await doctor({ "LAWS.bend": "" }, 0), /✓ bend: bend 2\.0\.39/);
  assert.match(await doctor({ "LAWS.bend": "" }, 1), /✗ bend: not found[\s\S]*install\.sh/);
  assert.doesNotMatch(await doctor({}, 1), /[✓✗] bend/);
});


const prompt = (found: any, useBend?: string) => setupPrompt(found, { version: 1, setup: "running", verify: [], connectors: [], language: "English", ...(useBend ? { useBend: useBend as any } : {}) }, false);

test("setup offers to record laws when the project has none: asks by default, skips the question under always, nothing under never", () => {
  const ask = prompt({});
  assert.match(ask, /pure logic[\s\S]*first ask the user[\s\S]*Never put a law in without approval/i);
  assert.match(ask, /command -v bend[\s\S]*install\.sh[\s\S]*never run it/);
  assert.doesNotMatch(prompt({}, "always"), /First ask the user with `ask_user` whether they want to record/);
  assert.match(prompt({}, "always"), /Draft each law in plain words/);
  assert.doesNotMatch(prompt({}, "never"), /LAWS\.bend|bend-lang/);
});

test("a project that already has laws gets the detection step, not the offer, whatever useBend says", () => {
  const found = { bend: { laws: "LAWS.bend", proof: "PROOF.bend", installed: true } };
  for (const mode of [undefined, "always", "never"]) {
    const text = prompt(found, mode);
    assert.match(text, /Never edit `LAWS\.bend`/);
    assert.doesNotMatch(text, /Draft each law/);
  }
});
