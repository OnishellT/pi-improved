import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_LINES, registerBasePrompt } from "../src/base-prompt.ts";
import { DEFAULT_ON_DEMAND, DEFAULT_SKILLS, type Phase } from "../src/manifest.ts";
import { buildPlanBrief } from "../src/plan-check.ts";
import { skillsBlock } from "../src/skills.ts";
import type { Plan, Task } from "../src/task-state.ts";
import { fakePi, tempProject } from "./helpers.ts";

test("DEFAULT_SKILLS gives each role only the skills it uses", () => {
  assert.deepEqual(DEFAULT_SKILLS, {
    setup: ["grilling", "domain-modeling", "pstack-technical-writing", "writing-for-agents", "pstack-create-verification-skill"],
    plan: ["tdd", "contract-first"],
    implement: ["tdd", "contract-first", "principles-implement"],
    diagnose: ["diagnosing-bugs", "principles-diagnose"],
    review: ["code-review", "pstack-blast-radius", "principles-review"],
    learn: ["retro", "correct", "pstack-maintain-verification-skill"],
  });
});

test("on-demand defaults per phase; interrogate and reflect stay opt-in", () => {
  assert.deepEqual(DEFAULT_ON_DEMAND, { setup: ["research"], plan: ["how", "architect", "codebase-design"], implement: ["handoff"], diagnose: ["why"], review: [], learn: [] });
  const all = new Set([...Object.values(DEFAULT_SKILLS), ...Object.values(DEFAULT_ON_DEMAND)].flat());
  for (const name of ["interrogate", "reflect"]) assert.ok(!all.has(name));
  for (const phase of Object.keys(DEFAULT_SKILLS) as Phase[]) for (const n of DEFAULT_ON_DEMAND[phase]) assert.ok(!DEFAULT_SKILLS[phase].includes(n));
});

test("plan-check brief has the naming rule and no tdd or contract-first body", async () => {
  const task: Task = { id: "t1", title: "T", status: "planning", allowedExtra: [], startedAt: "now" };
  const plan = { summary: "s", steps: ["a"], files: ["src/a.ts"], interface: [], seams: [], decisions: [] } as unknown as Plan;
  const brief = buildPlanBrief(task, plan, "ticket", []);
  assert.match(brief, /Naming rule/);
  assert.match(brief, /needs a source/);
  for (const name of ["tdd", "contract-first"]) assert.doesNotMatch(brief, new RegExp(`## Skill: ${name}`));
  const planBlock = await skillsBlock(await tempProject({}), "plan");
  assert.ok(planBlock.length > 0);
  assert.ok(!brief.includes(planBlock.slice(0, 200)));
});

test("the reviewer block holds only the review skills", async () => {
  const block = await skillsBlock(await tempProject({}), "review");
  for (const name of ["tdd", "contract-first", "unslop", "diagnosing-bugs"]) assert.doesNotMatch(block, new RegExp(`## Skill: ${name}\\b`));
  assert.match(block, /## Skill: pstack-blast-radius/);
});

test("base prompt is appended once, and not when basePrompt is false", async () => {
  const root = await tempProject({});
  const h = fakePi();
  registerBasePrompt(h.pi);
  const first = await h.emit("before_agent_start", { messageType: "user", systemPrompt: "SYS" }, { cwd: root });
  assert.ok(first.systemPrompt.startsWith("SYS\n\n"));
  for (const line of BASE_LINES) assert.ok(first.systemPrompt.includes(line));
  const again = await h.emit("before_agent_start", { messageType: "user", systemPrompt: first.systemPrompt }, { cwd: root });
  assert.equal(again, undefined);

  const off = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], basePrompt: false }) });
  assert.equal(await h.emit("before_agent_start", { messageType: "user", systemPrompt: "SYS" }, { cwd: off }), undefined);
});
