# Plan: pi-improved for Claude Code

Date: 2026-10-23. Target version: Claude Code 2.1.309 (installed). Status: plan, nothing implemented.

Goal: port the pi-improved workflow to Claude Code as **one plugin**, native features first, code well written, tested, language-agnostic. Integrate, do not reimplement, what Claude Code does (plan mode, subagents with own model, skills, hooks, permissions, MCP, memory, worktrees, cost).

Verification tags:

- [lab]: tested here on Claude Code 2.1.309 with haiku in lab repo `cc-lab/` (scratchpad), hooks dumping each event's JSON. Mod validated with `claude plugin validate`, typed with `tsc` against the engine types, tested with `claude plugin test`, loaded headless with `--plugin-dir`.
- [docs]: confirmed by an agent against the official docs (`code.claude.com/docs`) and CHANGELOG, section cited.
- [pending]: unconfirmed. Goes to phase 0 (spikes) before building on it.

## 1. What is native and what is not

| pi-improved piece | Native in Claude Code | Decision |
|---|---|---|
| Extension registering commands, hooks | Plugin: `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/` on Bash PATH, `package.json` + lockfile auto-installed [docs D11, D12] | Plugin |
| `/setup`, `/task`, `/models`, `/doctor`, `/verify` | Skills: frontmatter, `$ARGUMENTS`, injection `` !`cmd` ``, `disable-model-invocation` [docs C9] | Plugin skills |
| `task_plan` + single approval | Plan mode: plan file in `~/.claude/plans/`, approval via `ExitPlanMode`. Its `PreToolUse` hook gets `plan` (Markdown), `planFilePath`, can deny with reason [docs E13] | Plan mode + validator hook. Plan holds a block the hook parses |
| Questions with options (`ctx.ui.select`) | `AskUserQuestion` (model asks, hooks can't). Guards: `permissionDecision: "ask"` opens native permission dialog [docs A3] | Native. Code never asks: denies or requests permission, tells model what to ask |
| Model per phase (`setup`, `implement`, `review`, `escalate`) | `model:` in agent and skill frontmatter (alias, full id, `inherit`). `model` and `effort` per Agent tool call. `CLAUDE_CODE_SUBAGENT_MODEL` default [docs B6, B8] | Agents with own model. Strong model in `plan-check`, `reviewer`, `fixer` |
| Read-only review by child (pi-subagent + tmux) | Native subagents: `tools: Read, Grep, Glob`, `model: opus`, hooks `SubagentStart/Stop` carrying `agent_type`, `agent_transcript_path`, `last_assistant_message` [lab, docs A2] | Native agent. No tmux, no pi-subagent |
| Implementation "in session" | Subagent, trimmed context: prompt = plan + interface + seams + ADRs. `PreToolUse/PostToolUse` also fire inside with `agent_id`/`agent_type` [lab]. `Stop` in child is `SubagentStop`, can block [docs A2, A3] | Agent `implementer` (WORKFLOW stage 3, still to do in pi-improved) |
| `agent_before_settle` gate (contract, verify, retries) | `Stop` / `SubagentStop` hook: `decision: "block"` + `reason`. `stop_hook_active` prevents loops. Cap 8 continuations (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) [lab, docs A3] | Node command hook |
| Guards (`tool_call`: files outside plan, deps, migrations, interactive agentlint) | `PreToolUse`: `permissionDecision` allow/deny/ask, `permissionDecisionReason`, `updatedInput`, `additionalContext`. `if` with permission-rule syntax [docs A3, A4] | Node command hook |
| Injected phase skills | Native skills (`.claude/skills`, plugin `skills/`). `context: fork` + `agent:` runs a skill in a subagent. `skills:` in agent frontmatter [docs B6, C9] | Native: each agent declares its skills |
| Strong-model plan check | `agent` hook (experimental, multi-turn, `model`, `timeout`, returns `{ok, reason}`) on `PreToolUse` of `ExitPlanMode`. Or deny and have orchestrator launch `plan-check` [docs A4] | Option A: `agent` hook (spike). Fallback B: deny + subagent + `SubagentStop` |
| Review risk gating | None. Native `/code-review` (levels, `--fix`, background subagent) doesn't decide when to pay [docs F17] | Own lib `risk.ts` decides. If risky, gate requires review |
| Diff review | Native `/code-review` or own `reviewer` agent with brief (plan, ADRs, blast-radius) | Agent `reviewer` (contextual brief). `/code-review` as configurable alternative |
| Task memory (`tasks.jsonl`, related) | Auto-memory (`~/.claude/projects/<slug>/memory/`, 200 lines), `CLAUDE.md` with `@imports`, `.claude/rules/*.md` with `paths:` [docs C10] | Versioned `.claude/workflow/tasks.jsonl` + `` !`related` `` in `/task`. Auto-memory is personal, not repo |
| Cost telemetry per phase | `/cost`, `/usage`. OpenTelemetry `claude_code.cost.usage` with attributes `query_source` (main or subagent), `agent.name` [docs F16]. `--max-budget-usd` counts subagents | Native. Own metrics only for what the hook sees (verify failures, avoided reviews) |
| Jira/Linear connectors (read-only MCP) | Project `.mcp.json`: `http` + OAuth via `/mcp`, `enabledMcpjsonServers`, tools `mcp__<server>__<tool>` deferred behind ToolSearch [docs F18] | Native: `/setup` writes `.mcp.json` |
| Own `/doctor` | Native `/doctor`, `claude doctor`, `claude plugin validate` [docs F17] | Skill `/wf-doctor` for ours only (manifest, verify, agentlint, gh) |
| `isSubagentChild` (register nothing in child) | `agent_id`/`agent_type` in hook input [lab] | Hooks decide by `agent_type` |
| Pause on new package / migration | `PreToolUse` `ask` + reason. In `-p` with nobody to answer, denied and model reads reason [docs A3] | Command hook |
| Tools visible per phase (`setup_finish`, `task_plan`) | Classic layer has no dynamic tool registry. A mod does: `$.tool.register`, `tool.call`, `classic.Stop`, `prompt.compose`, `$.agent.spawn`, `$.process.run`, `$.ui.status`, pane [lab] | Not needed: `task_plan` = plan file, `setup_finish` = script. Mod left for phase 4 (on-screen state) |
| Best-of-N in worktrees | `--worktree`, `isolation: worktree` in agents, `worktree.baseRef`, `WorktreeCreate/Remove` hooks for non-git VCS [docs F20] | Out of scope (same portability objection). Door left open |

**Not** native, so we build: names verified against evidence (plain text), interface contract before verify, risk gating, retry order (fix → diagnose → escalate → person), repo task memory, repo scan for `/setup`.

## 2. Architecture

```
cc-improved/  (new repo, public or private, also a one-plugin marketplace)
├── .claude-plugin/
│   ├── plugin.json  name, version, description, userConfig (model per phase), dependencies
│   └── marketplace.json  one plugin, source "./" → /plugin marketplace add OnishellT/cc-improved
├── package.json + package-lock.json  Node >= 22, deps vendored or installed by Claude Code [docs D12]
├── bin/
│   ├── wf-hook.mjs  single hook entry: reads stdin, dispatches by hook_event_name
│   ├── wf-scan.mjs  repo discovery (stack, CI, commands, connectors) → JSON
│   ├── wf-related.mjs  related past tasks (tf-idf) → text
│   ├── wf-setup-finish.mjs  validates docs, skills, manifest, runs verify
│   └── wf-done.mjs  closes task: record in tasks.jsonl, retro every 5
├── lib/  portable core, no harness dependency (migrated from pi-improved/src)
│   ├── manifest.ts  .claude/workflow.json
│   ├── task-state.ts  .claude/workflow/task.json (local, gitignored)
│   ├── plan.ts  parses wf-plan block of plan file. planText
│   ├── contract.ts  missingNames, checkContract (unchanged)
│   ├── risk.ts  assessRisk on git diff (unchanged)
│   ├── triggers.ts  deps, migrations, manifests, installers (unchanged)
│   ├── verify.ts  runs manifest commands, bounded report
│   ├── learn.ts  records, relatedTasks, retro (unchanged)
│   ├── evidence.ts  ticket text (MCP), specs, cited files
│   └── hooks/  one module per event: pre-tool-use.ts, stop.ts, subagent-stop.ts, exit-plan-mode.ts, session-start.ts
├── hooks/hooks.json  classic: PreToolUse, Stop, SubagentStop, SessionStart, SubagentStart, PostToolUse(ExitPlanMode)
├── skills/
│   ├── setup/SKILL.md  /setup (injects !`node ${CLAUDE_PLUGIN_ROOT}/bin/wf-scan.mjs`)
│   ├── task/SKILL.md  /task (injects !`wf-related.mjs $ARGUMENTS`, enters plan mode)
│   ├── done/SKILL.md  /done (human closes task → wf-done)
│   ├── pr/SKILL.md  /pr (branch + PR with gh, attaches verify and risk report)
│   ├── wf-doctor/SKILL.md  own checks
│   ├── verify/SKILL.md  manual /verify
│   └── domain/…  vendored skills (grilling, tdd, diagnosing-bugs, blast-radius, retro, verification), `user-invocable: false`
├── agents/
│   ├── plan-check.md  read-only, strong model, VERDICT: OK|FIX
│   ├── implementer.md  Read/Edit/Write/Bash/Grep/Glob, model inherit, skills: tdd
│   ├── reviewer.md  read-only, strong model, skills: blast-radius
│   └── fixer.md  like implementer, strong model (escalation)
├── mod/  phase 4, optional: hooks module (register.ts) for on-screen state, per-turn cost
└── test/  node:test for lib, hook JSON fixtures, e2e with claude -p --plugin-dir
```

Per-project state (versioned): `.claude/workflow.json` = `{ version, setup, language, verify[], review{paths,always,never,plan}, connectors[], agentlint? }`. Local (gitignored): `.claude/workflow/task.json`. Session counters (retries, reviews, failures): `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`, because hooks fire in every open session of the project and must ignore other sessions' (lesson from official plugin ralph-loop).

Models: `plugin.json` → `userConfig` with `strong_model` (default `opus`) and `cheap_model` (default `inherit`). Agents use `model: ${user_config.strong_model}` [pending: confirm substitution applies to frontmatter `model`. If not, two agent variants and `/task` picks via the Agent tool `model`]. Orchestrator runs on the session model (`/model`), the cheap everyday one.

### Task flow on native primitives

1. `/task PAY-142 | description | path/spec.md`. Skill injects related tasks, reading instructions (MCP ticket, specs, CLAUDE.md, domain skills, ADRs, sibling files), plan template. Ends "enter plan mode" (`EnterPlanMode`). `SessionStart`, `UserPromptSubmit` not needed.
2. Orchestrator explores, writes plan (plan mode file) with block:
   ````
   ```wf-plan
   { "title", "ticket", "spec": [], "files": [], "interface": [{file, exports, signatures, source}], "seams": [{name, testFile, catches, misses}], "decisions": [{question, options, answer, source}] }
   ```
   ````
3. `ExitPlanMode` → `PreToolUse` command hook: parses block, requires `interface` and `seams`, verifies names against evidence (ticket text captured by `PostToolUse` of `mcp__*`, specs, cited files). Decision without source → deny, reason "ask with AskUserQuestion, record in decisions with the answer, save ADR in docs/adr/". Pass → saves `task.json` with `status: planning`.
4. Plan check, once. A: second `PreToolUse` hook, type `agent`, strong `model`, `timeout: 240`, prompt = `plan-check.ts` brief over `$ARGUMENTS`. `{ok:false, reason}` → orchestrator fixes, re-calls `ExitPlanMode`. B: command hook denies first time with "launch agent `wf:plan-check` and apply its verdict", `SubagentStop` (matcher `plan-check`) saves verdict from `last_assistant_message`.
5. Person approves in native dialog. `PostToolUse` of `ExitPlanMode` sets `status: implementing`. Per skill, orchestrator launches `wf:implementer` with trimmed brief (plan, interface, seams, touched ADRs, manifest verify). Planning conversation does not travel.
6. Implementer `PreToolUse` (agent_type `implementer`) guards: outside plan → `ask` + reason. New package or migration → `ask`. Interactive agentlint → `deny`. No `AskUserQuestion`: if it needs a decision it ends `BLOCKED: <question>`, orchestrator asks.
7. `SubagentStop` (matcher `implementer`): missing interface contract → `block`. Manifest `verify` fails → `block` + report. 2nd failure adds diagnosis method. 3rd: subagent exits `FAILED`, orchestrator launches `wf:fixer` (strong model) with report. More failures → orchestrator asks person.
8. Orchestrator `Stop` (task `implementing`): repeats contract + verify (defense in depth), computes risk with `risk.ts`. Risky and unreviewed → `block` "launch `wf:reviewer` and apply its findings". `SubagentStop` (matcher `reviewer`) records verdict. No second paid round. All pass → allow finish, add `systemMessage` summary (cost via `/cost`).
9. Person checks, writes `/done`: record in `tasks.jsonl`, `task.json` closed, automatic retro every 5 tasks (skills `retro` + `maintain-verification`). `/pr`: branch + PR via `gh` with verify, risk, new ADRs. Never pushes without an order.

### Setup on native primitives

`/setup` injects the scan (`wf-scan.mjs`: stack, package manager, CI, docs, candidate commands, remotes, ticket keys) and skills `grilling`, `domain-modeling`, `technical-writing`, `create-verification-skill`. Model interviews with `AskUserQuestion`, writes `CLAUDE.md` (instead of AGENTS.md, `@docs/...` to import), `GLOSSARY.md`, `docs/adr/`, `.claude/skills/domain-*/SKILL.md`, `.claude/skills/verify-app/SKILL.md`, `.claude/rules/*.md` with `paths:` for folder rules, `.mcp.json` for connectors (OAuth via `/mcp`), optionally agentlint. Ends with `node wf-setup-finish.mjs`: validates in code, runs verify, writes the manifest. A `Stop` hook pushes while `setup: running` (max 2 times per message, as today).

## 3. Phases

### Phase 0: spikes (half a day, < $1)

Close [pending] items before product code. Each spike is a reproducible script in `cc-lab/`.

| # | Check | How | Criterion |
|---|---|---|---|
| 0.1 | `PreToolUse` of `ExitPlanMode` carries `plan`, `planFilePath`. `deny` + reason returns to model | Interactive session (in `-p` with haiku the tool stayed deferred, not reached), hook dumps stdin | JSON has both fields. Model rewrites plan |
| 0.2 | `agent` hook on `PreToolUse`, `model: opus`, `timeout: 240`, reads files, returns `{ok:false, reason}` | hooks.json with `type: "agent"` | Reason reaches model. Cost < $0.30 |
| 0.3 | `SubagentStop` `decision: "block"` retries subagent. `stop_hook_active` on 2nd | Lab agent + hook | 2 rounds, then exits |
| 0.4 | `${user_config.strong_model}` substituted in agent frontmatter `model:` | `userConfig` + `claude plugin validate` + `/tasks` shows model | Correct model |
| 0.5 | `permissionDecision: "ask"` from hook in subagent reaches person's dialog | Interactive | Dialog shows reason |
| 0.6 | Plugin deps installed from `package-lock.json` on local-marketplace install | `claude plugin marketplace add <folder>` + install | `node_modules` present, hook with dependency runs |
| 0.7 | `PostToolUse` of `mcp__*` carries `tool_response` with ticket text (evidence) | Any MCP (Claude Docs works) | Text capturable |

Already closed in [lab]: hooks inside subagents with `agent_id`, `agent_type`. `Stop` block → continues → `stop_hook_active: true`. `last_assistant_message` in `Stop`, `SubagentStop`. Plan file in `~/.claude/plans/`. Mod: `$.tool.register`, `tool.call` (`{deny}` and `{result: string}`), `classic.Stop` `{block}`, `prompt.compose` with `id`, `$.agent.spawn` + `turn.complete(agentId, usage)`, `$.process.run`, `$.store`, `$.command.register`. `claude plugin validate/test`. `--plugin-dir` in `-p`.

### Phase 1: portable core (2 days)

- Create repo `cc-improved`: `package.json` (Node >= 22, `type: module`), `tsconfig`, `node --test`.
- Migrate from pi-improved to `lib/`: `contract.ts`, `risk.ts`, `triggers.ts`, `learn.ts`, `manifest.ts`, `task-state.ts`, `verify.ts` (no `pi.exec`: `child_process.execFile` with timeout, bounded output), `plan-check.ts` brief, `evidence.ts`. No harness imports. Existing tests migrate as is (121 green in pi-improved today. Drop those of `review.ts` and `subagent`: subagent is native).
- New `plan.ts`: parses the ```` ```wf-plan ```` block of the Markdown, validates with JSON Schema (typebox or ajv), returns errors readable by the model.
- `bin/wf-hook.mjs`: exits 0 with JSON or 0 with no output. Never throws (crashed hook is silently skipped). Logs to `${CLAUDE_PLUGIN_DATA}/log/`.
- Hook tests: real JSON fixtures captured in lab (already in `cc-lab/run*.hooks.log`) as input, assert JSON output.

Criterion: `npm test` green. `node bin/wf-hook.mjs < fixture` gives the expected decision for the 6 events.

### Phase 2: working plugin (3 days)

- `hooks/hooks.json`: `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit|Bash`, and `ExitPlanMode`), `PostToolUse` (`ExitPlanMode`, `mcp__.*`), `Stop`, `SubagentStop` (matchers `implementer|reviewer|plan-check|fixer`), `SessionStart` (warns if project has no setup, via `additionalContext`), `SubagentStart` (telemetry). Explicit timeouts. `if` with permission rules where it cuts runs.
- `skills/`: `setup`, `task`, `done`, `pr`, `verify`, `wf-doctor`. Vendored method skills `user-invocable: false` (model loads them, hidden from `/`).
- `agents/`: `plan-check`, `implementer`, `reviewer`, `fixer`, minimal `skills:` and `tools:`, `maxTurns` on read-only ones.
- `/setup` end to end in a test repo (copy, never the real one), `/task` with a small task. `claude plugin validate .` clean.
- `.claude-plugin/marketplace.json`, README with `/plugin marketplace add OnishellT/cc-improved` + `/plugin install cc-improved@cc-improved`.

Criterion: in a test repo, cheap model in session: plan rejected for invented name → fixed → plan check → approval → implementer blocked by verify → fixed → risk review → `/done` writes the record. No plugin code touched.

### Phase 3: evaluation (1 day, $5-8)

Reuse the pi-improved eval (`cc-lab/eval/`, copy of thereelcapital.com, hidden tests, `grade2.sh`): 10 tasks, two variants (blind, with interface hint), four arms: astra alone (A), current pi-improved (C+), Claude Code without plugin on cheap model (D0), with plugin (D1). Cost: `--output-format json` (`total_cost_usd` includes subagents), OTel if per-agent breakdown wanted. Driver: `claude -p --plugin-dir . --model <cheap> --permission-mode acceptEdits --max-budget-usd 1`.

Criterion: D1 ≥ C+ on tests with cost ≤ 1.5× C+. If not, back to phase 2 with failures classified (names, argument shape, verify, review).

### Phase 4: optional mod (1-2 days)

Only after phase 3. A `hooks module` (`register.ts`) that does **not** duplicate gates: `$.ui.status` with phase and turn tokens (`turn.complete.usage`), pane with `task.json` state (plan, verify, review, accumulated cost), `$.command.register('wf')` for the panel. Validated with `claude plugin validate`, typed with `tsc` against `.claude-plugin/types/`, tested with `claude plugin test`. Accepted risk: mod API is early access and changes between versions, so gates stay in classic hooks and the mod only draws.

### Phase 5: workflow close (1 day)

`/pr` with `gh` (repo template, verify report, risk, ADRs, `verify-app` evidence), adapted WORKFLOW.md, `claude plugin eval` with 3 cases (`evals/*/case.yaml`) to measure skill changes. Publish the marketplace, test `/plugin install` on a clean machine (the work one).

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `agent` hook is experimental (may change or fail) | Option B already designed: `deny` + native subagent + `SubagentStop` |
| `Stop` cap of 8 continuations | Our max is 3 retries + 1 review. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` documented if needed |
| Hooks fire in all sessions of the project | State per `session_id` in `CLAUDE_PLUGIN_DATA`. `task.json` carries `sessionId`, hooks ignore foreign ones |
| Implementer cannot ask | `BLOCKED:` protocol. Guards use `ask`, which reaches the person |
| `-p` denies any `ask` | Eval runs with `acceptEdits` and explicit `permissions.allow` rules. Plugin is for interactive use |
| Early access mods | Phase 4 isolated. Nothing critical depends on the mod |
| Plan mode in `-p` doesn't expose `ExitPlanMode` (seen with haiku) | Headless eval: `--permission-mode acceptEdits` and a `UserPromptSubmit` or skill requiring the `wf-plan` block in a repo file validated by `PostToolUse(Write)`. Interactive flow uses plan mode |
| Portability | Verify comes from the manifest. No fixed tsc/eslint. `wf-scan` only detects and proposes |

## 5. Decisions taken in this plan

1. Classic plugin first, mod after. Documented, stable features carry gates. Mod only improves experience.
2. Plan mode is `task_plan`. No invented tool: plan file with `wf-plan` block, `ExitPlanMode` as approval.
3. Implementer is a native subagent: WORKFLOW stage 3 (specific context), `SubagentStop` gates.
4. Strong model only in agents: `plan-check`, `reviewer`, `fixer`. Orchestrator uses the session model.
5. No tmux, no pi-subagent, no mandatory agentlint. Requirements: Node >= 22, git, `gh` for `/pr`.
6. Core in `lib/` without harness: same code 121 tests cover today, reusable if the harness changes.

## 6. How it is built: orchestrator and parallel subagents

Built with the scheme it sells: orchestrator session + subagents, one issue each, parallel, each in its own worktree.

**Dispatch.** Orchestrator (interactive session in new repo, strong model, `/loop` or by hand) takes open issues with no outstanding dependencies, launches one subagent per issue via Agent tool (`isolation: "worktree"`, `general-purpose` or repo `builder` agent with `tools: Read, Edit, Write, Bash, Grep, Glob`), waits, manages PRs. Subagent gets only: issue body, `docs/CONVENTIONS.md`, `lib/types.ts` (contracts), pi-improved files to migrate. Not the orchestrator's conversation.

**Subagent contract.** Branch `issue-<n>-<slug>`, touch only files the issue names, tests required, commit with `Co-Authored-By` line, `gh pr create` with `Closes #<n>` and repo template. Out-of-scope change needed → write it in the PR and stop. Never merge.

**Waves.** The issue dependency graph defines what runs in parallel:

| Wave | Issues | Parallel |
|---|---|---|
| 0 | scaffold | no (blocks all) |
| 1 | 7 spikes + shared contracts | yes, up to 8 subagents |
| 2 | lib/contract, risk, triggers, verify, learn, plan | yes, 6 |
| 3 | lib/evidence, bin/wf-hook (hook entry), method skills, agents | yes, 4 |
| 4 | hooks PreToolUse, ExitPlanMode, Stop/SubagentStop, Session. Skills task, setup, wf-doctor | yes, 7 |
| 5 | e2e | no |
| 6 | eval | no |
| 7 | mod, /pr | yes, 2 |
| 8 | docs and release | no |

**Merge.** Orchestrator merges a PR only if CI is green, Claude's PR review has no blocking findings (or resolved) and the PR closes its issue. Squash, linear history, branch deleted. After each merge, rebase or restart subagents whose wave depends on that issue. Conflicts: issues name disjoint files. Shared files (`lib/types.ts`, `hooks/hooks.json`, `package.json`) change only in `sequential` issues.

**Cost.** Cheap-model subagents for mechanical migrations (lib, vendored skills), strong for hooks with state machine and e2e. `--max-budget-usd` per orchestration session.

## 7. Repo, CI and reviewers

New public repo in the user's GitHub account: `OnishellT/cc-improved` (name free, checked with gh on 2026-10-23. gh is logged in as `OnishellT`, scopes `repo` and `workflow`).

- CI (`.github/workflows/ci.yml`, job `test`): Node 22, `npm ci`, `npm run typecheck`, `npm test`, `claude plugin validate .`. Runs on every PR and on `main`.
- PR review (`.github/workflows/claude-review.yml`, job `claude-review`): `anthropics/claude-code-action@v1` with `claude_code_oauth_token` (secret `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`). Prompt reads `docs/CONVENTIONS.md`, checks scope, tests, portability, language-agnostic rule, non-throwing hooks. Read-only plus `gh pr view/diff/comment`. Comments on the PR, says `LGTM` when nothing blocks.
- `main` protection: PRs only, checks `test` and `claude-review` required and up to date, linear history, no force push, conversations resolved. No formal approval required: in a one-person repo the author can't approve and the action comments without approving. The two checks are the real gate.
- `CODEOWNERS` with `@OnishellT`, PR template (`Closes #`, test checklist, "out of scope"), `docs/CONVENTIONS.md`, MIT.

Prepared in this session's scratchpad, `cc-improved-bootstrap/`: `scaffold/` (repo files), `issues.json` (labels, milestones, 31 issues with dependencies by key), `bootstrap.sh` (creates repo, pushes scaffold, creates labels, milestones and issues resolving dependencies to numbers, protects `main`). Runs only on the user's order. Token secret added by hand.

## 8. Issues

31 issues in 6 milestones (M0 Spikes, M1 Core, M2 Plugin, M3 Eval, M4 Mod, M5 Release). Labels `parallel-ok`, `sequential` mark what a subagent can do in parallel. Each issue has scope, acceptance and "depends on" with links to its issues. Summary:

| # | Issue | Milestone | Parallel |
|---|---|---|---|
| 1 | Scaffold: package.json, tsconfig, node:test, CI, conventions | M0 | no |
| 2 | Shared contracts: types, wf-plan schema, hook fixtures | M1 | no |
| 3-9 | Spikes 0.1 to 0.7 (ExitPlanMode, agent hook, SubagentStop, userConfig, ask in subagent, npm deps, MCP evidence) | M0 | yes |
| 10-15 | lib/contract, risk, triggers, verify, learn, plan | M1 | yes |
| 16 | lib/evidence + plan-check brief | M1 | no |
| 17 | bin/wf-hook.mjs: single hook entry | M2 | no |
| 18-21 | Hooks PreToolUse, ExitPlanMode, Stop/SubagentStop, Session | M2 | yes |
| 22 | Agents plan-check, implementer, reviewer, fixer | M2 | yes |
| 23-26 | Skills /task /done /verify, /setup, vendored method skills, /wf-doctor | M2 | yes |
| 27 | e2e integration in test repo | M2 | no |
| 28 | Eval 10 tasks, 4 arms | M3 | no |
| 29 | Optional mod | M4 | yes |
| 30 | Skill /pr | M5 | yes |
| 31 | Docs, skill evals, marketplace, clean install | M5 | no |

Numbers are those `bootstrap.sh` assigns when creating them in order.

## 9. Inventory of what was verified in the lab

Files in this session's scratchpad, `cc-lab/`: `.claude/settings.json` (dump hooks), `hooks/dump.sh`, `run1.hooks.log` (all events of a session with subagent), `run2.hooks.log` (plan mode), `hooks.log` (session with the mod), `mod-lab/` (validated mod: `hooks/register.ts`, `hooks/guard.test.ts`, `agents/plan-check.md`), `mod-lab-ts/tsconfig.json` (typing against the engine types).
