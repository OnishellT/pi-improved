# Workflow

One idea: **the cheap model implements, code decides when work advances, and the strong model and the person step in only where they add value.** Below is the expected flow from first session to deploy, and what the package covers today.

Everything is **language- and framework-agnostic**. No stack-specific gates ship in the package. Verification commands come from the project (`.pi/workflow.json`). Code checks read plain text (names, files, diffs) and never parse a language.

## Flow at a glance

| # | Stage | Who | Tools | Status |
|---|-------|-----|-------|--------|
| 1 | Initial setup: docs, skills, rules | `setup` model + person | `/setup`, setup skills, agentlint | Covered |
| 2 | Planning | `implement` model, `review` model check | `/task`, `task_plan`, verified names, plan check | Covered |
| 3 | Implementation with specific context | `implement` model | Approved plan, `tdd` skill, automatic pauses | Covered in session. Isolated subagent pending |
| 4 | Real verification in the expected environment | Code (`verify`) | `verify-app` (browser, CLI, API or TUI), compiler, linter, tests | Covered |
| 5 | agentlint | Code (`verify`) | Rules in `.agentlint/config.ts` | Covered |
| 6 | Error correction | Orchestrator. 3rd failure: `escalate` model | `verify` gate, `diagnosing-bugs` skill, diff review | Covered |
| 7 | PR with static checks | Orchestrator | Setup skills and tools | Pending |
| 8 | PR review in CI | Project CI | Linters, tests, agentlint | Out of package |
| 9 | Deploy | Project CI/CD | Project pipeline | Out of package |
| 10 | Manual verification | Person | Deployed environment | Out of package |

**Covered**: package code runs it and blocks on failure. **Pending**: next piece to build. **Out of package**: project and person work that pi-improved prepares but does not run.

## 1. Initial setup

Once per repo, with the strongest model available (`models.setup`). Its output is the context cheap models read later, so spend here.

`/setup` does:

1. **Scan (code, no model):** stack, package manager, CI, docs, candidate verify commands, and connectors (Jira, Linear) from the git remote, ticket keys in commits and URLs in docs. Then ask the minimum: language, and one read-only confirmation per connector.
2. **Interview:** the model follows the `grilling` skill. One question at a time via `ask_user`, recommended option first, nothing the code answers. About 12 questions at most.
3. **Documents:** `GLOSSARY.md`. `AGENTS.md` (max 150 lines: purpose, stack, commands, map, conventions, MUST/NEVER rules). `docs/adr/` for decisions the code shows or the person confirmed. `.pi/skills/domain-<area>/SKILL.md` per business area.
4. **App verification skill:** following `pstack-create-verification-skill`, write `.pi/skills/verify-app/SKILL.md` with an executable script when the app can run without a person: headless browser (web), the binary (CLI), calls (API), the terminal (TUI). Evidence goes to `.pi/evidence/`. Stage 4 uses it to test real behavior, not only unit tests. If a GUI-driving CLI is available (`pi-desktop` on PATH, or the desktop turned on with `/computer`; see [COMPUTER.md](COMPUTER.md)), the scan reports it and the script may use it for what a headless run cannot reach. Only command line tools qualify: `verify` trusts exit codes, so MCP-only drivers cannot gate.
5. **Rules (Node projects only):** if the person accepts, install agentlint and turn up to 3 `AGENTS.md` MUST/NEVER rules the person picks into agentlint rules: those a pattern can detect but a person must judge. Human authority by default. Adopt gradually. Never accept findings in bulk.
6. **`verify`:** leave the project's verify commands ordered fastest first (compiler or typechecker, linter, tests, `verify-app`, agentlint), then call `setup_finish`. It checks in code that files exist and are well formed, runs `verify`, and asks for one approval.

If the model stops early, a hook pushes it on (max 2 times per message). If `verify` fails 3 times, the person decides.

Result: `.pi/workflow.json` with `setup: "done"`, `verify`, `models`, `connectors`, and `agentlint` if used. Versioned.

## 2. Planning

`/task <description | PAY-142 | path/to/spec.md>` starts a task. The orchestrator (`implement` model) reads the ticket via MCP, named spec files, `GLOSSARY.md`, `AGENTS.md`, related skills and ADRs, similar past tasks from `.pi/memory/tasks.jsonl`, and the code it will touch plus its sibling files. It edits nothing.

It then calls `task_plan` with:

- `summary`, `steps`, `files`.
- `decisions`: only choices no document settles, 2 to 4 options each. Choices the code cannot resolve go to the person and are stored as ADRs in `docs/adr/`.
- `interface`: file, exports and signatures the tests will import, citing the source (ticket, doc or existing file).
- `seams`: test points per the `tdd` skill. Each ticket acceptance criterion, invalid-input ones included, needs one.

Two checks run before the person is asked to approve:

- **Verified names** (`src/contract.ts`). Each `interface` name must appear literally, as a word, in its cited source: ticket text read via MCP, spec files named in `/task`, docs, or existing code. A new file needs every word of its name in that source. Anything absent counts as invented and is asked. Plain text, any language.
- **Plan check** (`src/plan-check.ts`). A read-only child with the `review` (or `setup`) model reads the ticket, interface and sibling files. It returns `VERDICT: OK` or a fix list: names that break the folder convention, argument shapes that differ from the ticket's, existing helpers being duplicated, invalid inputs left uncovered. Once per task. On fixes, the orchestrator corrects the plan and calls `task_plan` again. `"review": { "plan": false }` turns it off.

The person approves the plan once. `.pi/task.json` becomes `implementing`.

## 3. Implementation with specific context

Target: **an agent that receives only what it needs** implements. Its input is the approved plan, interface, seams, relevant ADRs and phase skills. No planning conversation, no other tasks. The less context a cheap model carries, the better it follows the plan.

Today: implementation runs in the same pi session with the `implement` model, `tdd` injected and the plan as contract. The existing subagents are read-only (plan check, diff review). Moving implementation to a trimmed-context subagent is the next step. The surrounding pieces (gates, pauses, verification) are done and will not change.

Code pauses and asks when the agent:

- touches files outside the plan's `files`;
- adds dependencies, by command or by editing `package.json`, `pyproject.toml`, `go.mod`, etc.;
- creates migrations or changes schemas.

If the agent writes a question in plain text instead of using `ask_user`, a nudge reminds it.

## 4. Real verification

When the agent calls the task done, code does not believe it. In `agent_before_settle`:

1. **Interface contract.** Each plan export must appear in its file. If one is missing, the task returns to the agent without spending verify time or review money.
2. **`verify`.** Commands from `.pi/workflow.json` run in order: fast ones first (compiler, typechecker, linter), then tests, then `verify-app`. `verify-app` exercises the functionality in the real environment with the tools setup left: open the screen in the headless browser, run the CLI command, call the endpoint, walk the TUI. Evidence goes to `.pi/evidence/`.

The agent cannot close the task while `verify` is red. It gets 3 automatic retries, then the person decides. `/verify` runs it by hand. Commands come from the project, so the same flow serves TypeScript, Python, Go or anything else.

## 5. agentlint

`agentlint check --all` is one more `verify` step. It checks the MUST/NEVER rules setup turned into code. If a rule fails:

- the agent gets one attempt to fix the code;
- if it fails again, the person decides: fix, or record the exception. The exception is approved with `agentlint approve` and a human actor, because pi has no TTY and may run inside another agent.

Guards: `agentlint accept` and `approve` always ask the person, even when the rule lets the agent decide. Commands that open the interactive UI (`review`, `--review`, `--wizard`) are blocked, because they would wait for someone.

## 6. Error correction

The `verify` report returns to the orchestrator with instructions. Pressure rises with each failure:

| Failure | What happens |
|---------|--------------|
| 1st | "Fix it and finish." |
| 2nd | `diagnosing-bugs` skill injected: reproduce, isolate, hypothesize, then touch code. |
| 3rd | Switch to the `escalate` model (or `review`, or `setup`) for that attempt. |
| More | The person decides: continue or drop. |

When `verify` passes and the diff is risky (large, new dependencies, migrations, sensitive paths, new decisions), a read-only child with the `review` model reviews the diff against the plan, ADRs and `AGENTS.md`, following `pstack-blast-radius`. One round. If it asks for changes, the cheap model makes them and `verify` checks them, not another paid review. A small diff outside sensitive areas pays no review. Without tmux, or on failure, the review is skipped and the person is told.

When the person confirms the task is done, a record goes to `.pi/memory/tasks.jsonl` (versioned). It feeds the planning of future tasks (stage 2). Every 5 tasks, a retro runs with the `retro` skill and the verification skill is reviewed with `pstack-maintain-verification-skill`.

## 7. PR with static checks

Pending. Expected: on closing the task, the orchestrator prepares the branch and PR with the tools setup identified (hosting CLI, the repo's PR template). It attaches the static check results: `verify` commands, agentlint findings, plan summary, new ADRs, and `verify-app` evidence when it exists. Nothing is pushed without the person's order.

## 8. PR review in CI

Out of package, but setup prepares it. The same `verify` commands, agentlint included, must run in the project's CI. What passes locally must pass in CI with the same list. If they diverge, setup or the retro fixes it.

## 9. Deploy

Out of package. The project pipeline deploys once the PR is approved.

## 10. Manual verification

Out of package, on purpose. A person has the last word on functionality in the deployed environment. `verify-app` and `.pi/evidence/` make that check short and targeted. They do not replace it.

## Internals

**State.** `.pi/workflow.json` is project state (versioned): setup, `verify`, `models`, `skills`, `connectors`, `review`, `agentlint`. `.pi/task.json` is the active task (local, in `.gitignore`): `status` (`planning` | `implementing` | `done`), `plan`, `spec`, `planChecks`, `allowedExtra`.

**Models per phase.** `/models` sets `setup`, `implement`, `review` and `escalate` as `provider/model`. A missing phase uses the session model. The strong model runs once in setup, in the plan check, in the diff review when risky, and on the third fix attempt. Everything else uses the cheap model.

**Skills per phase.** Skills live in `vendor/skills/` and are injected into each phase prompt (`/skills` changes them). setup = grilling, domain-modeling, technical-writing, create-verification-skill. plan and implement = tdd. diagnose = diagnosing-bugs. review = blast-radius. learn = retro, maintain-verification-skill. The model never picks a skill.

**Gates.** All blocking happens in code, on pi events: `agent_before_settle` (contract, verify, review, close), `tool_result` (write count, MCP text as ticket evidence) and `tool_call` (files outside the plan, dependencies, migrations, interactive agentlint commands). `setup_finish` and `task_plan` are visible only in their phase.

**Subagents.** Children launch via pi-subagent in tmux, read-only (`read,grep,find,ls`), with a brief file and a time limit. Inside a child (`PI_SUBAGENT_RUN_DIR`) the extension registers nothing: no setup offers, blocks or questions nobody can see. Their cost goes to the task telemetry.

**Portability.** `pi install git:github.com/OnishellT/pi-improved` is enough. pi-subagent and agentlint are bundled. System requirements that cannot be packaged: Node >= 22.18, git, tmux. `/doctor` checks them.

## Pending

1. **Implementer subagent** with trimmed context (stage 3).
2. **PR creation** with static checks attached (stage 7).
3. **Evaluation with more tasks**, plus a variant with an interface hint, to measure quality on the full flow.
