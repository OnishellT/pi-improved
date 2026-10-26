import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, buildBody, newAdrs, prTitle, runPr, scrub, type PrFacts } from "../src/pr.ts";
import { fakeUI, tempProject } from "./helpers.ts";

const plan = { summary: "Add the thing", steps: ["step one"], files: [], decisions: [] as any[], interface: [], seams: [{ name: "parser", testFile: "t", catches: "bad input", misses: "io" }] };
const task: any = { id: "t", title: "Add the thing", ticket: "42", status: "done", allowedExtra: [], startedAt: "", plan };
const facts: PrFacts = { branch: "task/42", base: "origin/main", commits: ["abc1234 add it"], changes: ["A\tdocs/adr/0002-x.md", "M\tsrc/a.ts"], dirty: ["?? docs/adr/0003-y.md"], gh: true, origin: "git@x:y.git", hasEvidenceSkill: false };

test("branch name: ticket, else title slug, never an AI tool", () => {
  assert.equal(branchName(task), "task/42");
  assert.equal(branchName({ ...task, ticket: undefined, title: "Fix Ünicode bug!" }), "task/fix-unicode-bug");
  assert.equal(branchName(undefined), "task/change");
  assert.equal(branchName({ ...task, ticket: "claude-fix" }), "task/change");
});

test("new ADRs: added in the diff plus untracked ones", () => {
  assert.deepEqual(newAdrs(facts.changes, facts.dirty), ["docs/adr/0002-x.md", "docs/adr/0003-y.md (uncommitted)"]);
});

test("scrub removes attribution and tool mentions", () => {
  assert.equal(scrub("ok\nCo-Authored-By: Someone\nGenerated with Claude Code\nfine"), "ok\nfine");
  assert.equal(prTitle({ ...task, ticket: undefined, title: "Ask Claude" }, []), "Changes");
});

test("body: summary, closes, verify, risk, ADRs, tests", () => {
  const body = buildBody({ task, facts, verify: { ok: true, text: "verify passed\n✓ npm test" }, risk: { review: true, reasons: ["8 files"] } });
  assert.match(body, /## Summary\nAdd the thing\n\n- step one\n\nCloses #42/);
  assert.match(body, /Passed:[\s\S]*✓ npm test/);
  assert.match(body, /Risky: 8 files\./);
  assert.match(body, /- docs\/adr\/0002-x\.md\n- docs\/adr\/0003-y\.md \(uncommitted\)/);
  assert.match(body, /parser: catches bad input; misses io/);
  assert.doesNotMatch(body, /Evidence/);
});

test("body: template kept, evidence note, no verify steps", () => {
  const body = buildBody({ task: undefined, facts: { ...facts, template: "## Checklist\n- [ ] x\n", hasEvidenceSkill: true }, verify: "none" });
  assert.ok(body.startsWith("## Checklist\n- [ ] x\n\n---"));
  assert.match(body, /no verification steps/);
  assert.match(body, /## Evidence/);
  assert.match(body, /- abc1234 add it/);
});

type Call = [string, string[]];
function setup(opts: { branch?: string; gh?: boolean; verifyCode?: number } = {}) {
  const calls: Call[] = [];
  const exec: any = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", killed: false });
    if (cmd === "bash") return { code: opts.verifyCode ?? 0, stdout: "out", stderr: "", killed: false };
    if (cmd === "gh") return args[0] === "--version" ? (opts.gh === false ? { code: 1, stdout: "", stderr: "", killed: false } : ok("gh 2")) : ok("https://example/pr/1");
    if (cmd !== "git") return ok();
    if (args[0] === "branch") return ok(`${opts.branch ?? "task/42"}\n`);
    if (args[0] === "rev-parse" && args.includes("origin/HEAD")) return { code: 1, stdout: "", stderr: "", killed: false };
    if (args[0] === "log") return ok("abc1234 add it\n");
    if (args[0] === "remote") return ok("git@x:y.git\n");
    return ok();
  };
  return { exec, calls, has: (cmd: string, first: string) => calls.some(([c, a]) => c === cmd && a[0] === first) };
}
const project = () => tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["npm test"], connectors: [], review: { never: true } }) });

test("nothing is pushed or opened without a confirmation", async () => {
  const { exec, has } = setup();
  const ui = fakeUI([false]);
  const out = await runPr(exec, await project(), ui, undefined);
  assert.equal(out.status, "declined");
  assert.deepEqual(ui.asked, ["Open the PR?"]);
  assert.ok(!has("git", "push") && !has("gh", "pr"));
});

test("a yes pushes the branch and opens the PR against the base", async () => {
  const { exec, calls } = setup();
  const out = await runPr(exec, await project(), fakeUI([true]), "main");
  assert.deepEqual(out, { status: "opened", detail: "https://example/pr/1" });
  assert.ok(calls.some(([c, a]) => c === "git" && a.join(" ") === "push -u origin task/42"));
  const create = calls.find(([c, a]) => c === "gh" && a[0] === "pr")![1];
  assert.deepEqual(create.slice(0, 3), ["pr", "create", "--base"]);
  assert.equal(create[3], "main");
});

test("failing verify asks before going on; declining stops", async () => {
  const { exec, has } = setup({ verifyCode: 1 });
  const ui = fakeUI([false]);
  const out = await runPr(exec, await project(), ui);
  assert.equal(out.status, "declined");
  assert.deepEqual(ui.asked, ["Verify failed"]);
  assert.ok(!has("git", "push"));
});

test("on the base branch: needs a confirmed task branch first", async () => {
  const refused = setup({ branch: "main" });
  assert.equal((await runPr(refused.exec, await project(), fakeUI([false]))).status, "not-ready");
  assert.ok(!refused.has("git", "switch"));
  const accepted = setup({ branch: "main" });
  const out = await runPr(accepted.exec, await project(), fakeUI([true, false]));
  assert.equal(out.status, "declined");
  assert.ok(accepted.has("git", "switch"));
});

test("without gh nothing is asked or pushed: the body is shown", async () => {
  const { exec, has } = setup({ gh: false });
  const ui = fakeUI([]);
  const out = await runPr(exec, await project(), ui);
  assert.equal(out.status, "shown");
  assert.deepEqual(ui.asked, []);
  assert.ok(!has("git", "push"));
});
