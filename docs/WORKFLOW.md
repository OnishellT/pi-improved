# Workflow

One idea: **the cheap model implements, code decides when work advances, and the strong model and the person step in only where they add value.** Below is the expected flow from first session to deploy, and what the package covers today.

Everything is **language- and framework-agnostic**. No stack-specific gates ship in the package. Verification commands come from the project (`.pi/workflow.json`; every key is in the [README table](../README.md#state)). Code checks read plain text (names, files, diffs) and never parse a language.

## Flow at a glance

| # | Stage | Who | Tools | Status |
|---|-------|-----|-------|--------|
| 1 | Initial setup: docs, skills, rules | `setup` model + person | `/setup`, setup skills, agentlint | Covered |
| 2 | Planning | `implement` model, `review` model check | `/task`, `task_plan`, verified names, plan check | Covered |
| 3 | Implementation with specific context | `implement` model | Approved plan, `tdd` skill, automatic pauses | Covered (isolated subagent: see Pending) |
| 4 | Real verification in the expected environment | Code (`verify`) | `verify-app` (browser, CLI, API or TUI), compiler, linter, tests | Covered |
| 5 | agentlint | Code (`verify`) | Rules in `.agentlint/config.ts` | Covered |
| 6 | Error correction | Orchestrator. 2nd failure: `escalate` model; 3rd: the person decides | `verify` gate, `diagnosing-bugs` skill, diff review | Covered |
| 7 | PR with static checks | Orchestrator | `/pr`, `gh`, the repo's PR template | Covered |
| 8 | PR review in CI | Project CI | Linters, tests, agentlint | Out of package |
| 9 | Deploy | Project CI/CD | Project pipeline | Out of package |
| 10 | Manual verification | Person | Deployed environment | Out of package |

**Covered**: package code runs it and blocks on failure. **Pending**: next piece to build. **Out of package**: project and person work that pi-improved prepares but does not run.

## 1. Initial setup

Once per repo, with the strongest model available (`models.setup`). Its output is the context cheap models read later, so spend here.

`/setup` does:

1. **Scan (code, no model):** stack, package manager, CI, docs, candidate verify commands, and connectors (Jira, Linear) from the git remote, ticket keys in commits and URLs in docs. Then ask the minimum: language, and one read-only confirmation per connector.
2. **Interview:** the model follows the `grilling` skill. One round at a time, each one `ask_user` call (at most 5 questions), recommended option first, nothing the code answers. About 12 questions at most (`limits.interviewQuestions`).
3. **Documents:** `GLOSSARY.md`. `AGENTS.md` (max 150 lines: purpose, stack, commands, map, conventions, MUST/NEVER rules). `docs/adr/` for decisions the code shows or the person confirmed. `.pi/skills/domain-<area>/SKILL.md` per business area.
4. **App verification skill:** following `pstack-create-verification-skill`, write `.pi/skills/verify-app/SKILL.md` with an executable script when the app can run without a person (a features map under `.pi/skills/verify-app/features/`, one file per feature, plus `features/coverage.json` with `sync` (the output of `git rev-parse HEAD`) and `paths` (the code the map covers)): headless browser (web), the binary (CLI), calls (API), the terminal (TUI). Evidence goes to `.pi/evidence/`. Stage 4 uses it to test real behavior, not only unit tests. If a GUI-driving CLI is available (`pi-desktop` on PATH, or the desktop turned on with `/computer`; see [COMPUTER.md](COMPUTER.md)), the scan reports it and the script may use it for what a headless run cannot reach. Only command line tools qualify: `verify` trusts exit codes, so MCP-only drivers cannot gate.
5. **Rules (Node projects only):** if the person accepts (or `useAgentlint` is `always`; `never` skips this step), install agentlint and turn up to 3 (`limits.agentlintRules`) `AGENTS.md` MUST/NEVER rules the person picks into agentlint rules: those a pattern can detect but a person must judge. Human authority by default. Adopt gradually. Never accept findings in bulk. If the person turns agentlint down later, `setup_finish` offers to drop it instead of refusing for a missing config.
6. **`verify`:** leave the project's verify commands ordered fastest first (compiler or typechecker, linter, tests, `verify-app`, agentlint), then call `setup_finish`. It checks in code that files exist and are well formed (for the verify-app skill: a script, a features map whose files have their headings, and a required `coverage.json` whose `sync` resolves to a commit (`git cat-file -e <sync>^{commit}`) and whose `paths` all exist), runs `verify`, and asks for one approval.

If the model stops early, a hook pushes it on (max 2 times per message). If `verify` fails 3 times, the person decides.

Result: `.pi/workflow.json` with `setup: "done"`, `verify`, `models`, `connectors`, and `agentlint` if used. Versioned.

## 2. Planning

`/task <description | PAY-142 | path/to/spec.md>` starts a task. The orchestrator (`implement` model) reads the ticket via MCP, named spec files, `GLOSSARY.md`, `AGENTS.md`, related skills and ADRs, similar past tasks from `.pi/memory/tasks.jsonl`, and the code it will touch plus its sibling files. It edits nothing: write and edit calls are blocked until the plan is approved.

It then calls `task_plan` with:

- `intent`: the ticket restated in the plan's own words, one short paragraph. Required. The plan check and the review compare against it, the approval dialog and the `/pr` Summary show it, and it goes into the memory record.
- `summary`, `steps`, `files`.
- `decisions`: only choices no document settles, 2 to 4 options each. Choices the code cannot resolve go to the person and are stored as ADRs in `docs/adr/`. pi writes them once the plan is approved, not the model, and tells the model their paths so it keeps them in the change. What the person already answered through `ask_user` while planning is added as a decided choice too, with its ADR, and is not asked again.
- `interface`: file, exports and signatures the tests will import, citing the source (ticket, doc or existing file), and, for callables, an optional `usage`: the call a test would make, in the ticket's words (e.g. `slugify("Hello World")`). `usage` is plan text, not a gate: the plan check reads it, and the review brief lists it.
- `seams`: test points per the `tdd` skill. Each ticket acceptance criterion, invalid-input ones included, needs one.

Two checks run before the person is asked to approve:

- **Verified names** (`src/contract.ts`). Each `interface` name must appear literally, as a word, in its cited source: ticket text read via MCP, spec files named in `/task`, docs, or existing code. A new file needs every word of its name in that source. Anything absent counts as invented and is asked. Plain text, any language.
- **Plan check** (`src/plan-check.ts`). A read-only child with the `review` (or `setup`) model reads the ticket, interface and sibling files. It returns `VERDICT: OK` or a fix list: names that break the folder convention, argument shapes that differ from the ticket's, existing helpers being duplicated, invalid inputs left uncovered, files missing from or wrongly in scope, and an intent that does not restate the ticket. Once per task (`limits.planChecks`; `0` turns it off). Off unless `review.plan`, `review.always` or a `review.minLevel` other than `off` (default `high`, see the README table) asks for it; the policy applies only when the plan touches high-risk files. On fixes, the orchestrator corrects the plan and calls `task_plan` again.

**Fast path.** A small plan skips the approval dialog: at most 8 files, 6 interface entries and 2 decisions (`limits.fastPath.files`, `.interface`, `.decisions`), and no risk trigger (dependency files, migrations, sensitive areas, `review.paths`, `review.always`; `planRiskReasons` in `src/risk.ts`). It still passes the same gates above (verified names, seams in scope, decisions, plan check when enabled); the plan is shown as a notice. Anything bigger or riskier gets the normal approval: the person approves the plan once. `.pi/task.json` becomes `implementing`.

**Baseline.** On approval, when setup is `done`, code runs every `verify` command once, before the change, none stopping the others. It shows a `baseline` status line, uses the gate's normal verify timeout per command and stops when the tool call is aborted. It stores in `task.baseline` the outcome (`ok`, or one failure signature per failing step: the step and all its output lines, times, durations and hex addresses normalized, empty lines dropped, repeats kept) and the first command's duration in seconds.

**Mode.** In `direct` (default) the agent works from `AGENTS.md` and the skills, and `/task` is optional. In `flow`, `/task` is the recommended route. `/setup` writes `direct` if unset and has the model add two short `AGENTS.md` sections: "Before finishing" (the `verify` commands) and "When to use /task" (dependencies, migrations, `review.paths`, big changes). Without an active task only the verify gate runs, after a turn that changed files; the contract check, the review and the "is the task done?" question need a task in `implementing`. `/doctor` validates `mode`.

## 3. Implementation with specific context

Target: **an agent that receives only what it needs** implements. Its input is the approved plan, interface, seams, relevant ADRs and phase skills. No planning conversation, no other tasks. The less context a cheap model carries, the better it follows the plan.

Code pauses and asks when the agent (while the task is `implementing`):

- touches files outside the plan's `files`;
- adds dependencies, by command or by editing `package.json`, `pyproject.toml`, `go.mod`, etc.;
- creates migrations or changes schemas.

Without a UI (print mode) nobody can answer, so the scope and migration pauses are off, and a new dependency, or a manifest edit that cannot be checked, is denied with a reason to the agent.

If the agent writes a question in plain text instead of using `ask_user`, a nudge reminds it.

Every `limits.verifyEvery` writes (default 5; `0` turns it off), code runs the first `verify` command and appends the result to the write or edit result as a "Progress check". It is a hint, not the gate: nothing is blocked and no retry is counted. It runs only when the baseline's first step took under 30 s (otherwise it is off, and the first write result says why, once) and has a 60 s cap. A failure can be expected mid-change (a test for code not written yet), so the result tells the agent to fix it only if it is not.

## 4. Real verification

When the agent calls the task done, code does not believe it. In `agent_before_settle`:

1. **Interface contract.** Each plan export must appear in its file. If one is missing, the task returns to the agent without spending verify time or review money.
2. **`verify`.** Commands from `.pi/workflow.json` run in order: fast ones first (compiler, typechecker, linter), then tests, then `verify-app`. `verify-app` exercises the functionality in the real environment with the tools setup left: open the screen in the headless browser, run the CLI command, call the endpoint, walk the TUI. Evidence goes to `.pi/evidence/`.

The agent cannot close the task while `verify` is red. It gets 2 automatic retries (`limits.verifyRetries`; fix once, then escalate), then the person decides. Interface-contract misses have their own retries, the same number. The escalation comes after 2 failures (`limits.failuresBeforeEscalation`). A step that fails only with lines it already had at the baseline does not stop the run: later steps still run. If every failing step predates (same step, every output line also in the baseline's at least as many times: a new line, or one printed more often, makes it new; a step the baseline never saw fail, or an agentlint failure, is new), the gate does not block and counts no retry: the agent finishes with the note "verify fails, but only with failures that predate this change", the user is told once, the completion dialog is titled "Only old failures remain" and lists the failing steps, and `/pr` lists them under verify. The agentlint step is the one setup recorded (`agentlintStep`, always a step of its own) or a bare `agentlint check …`; a script or compound command that also runs agentlint is an ordinary step, and the words in the output do not matter. The recorded step runs first. A setup from before the record gets the standard step added and recorded the first time its manifest is read. If unsure, the failure counts as new. The gate treats a new commit like any other change, so work made and committed through bash is verified too. If Nix is missing or cannot build its package (offline, disk full), verify did not run: the user gets Nix's message, and no retry, escalation or model turn is spent. `/verify` runs it by hand. Commands come from the project, so the same flow serves TypeScript, Python, Go or anything else.

## Optional: Bend laws

For a rule that must never break (pricing, permissions, a state machine), a project can keep `LAWS.bend`, written by a human, at its root. [Bend](https://bend-lang.com) is a language where the agent can prove such laws in `PROOF.bend`; it proves Bend code only. For any other language the agent writes a small Bend model of the rule, proves the laws on it, and adds a test to the project's own suite that compares the real code with the model (through `bend Model.bend <args>` or a compiled binary).

- `/setup` can also create laws: when the interview finds pure-logic invariants and the project has no `LAWS.bend`, it offers to record them (`useBend` in `.pi/workflow.json`: `ask` by default, `always` skips the question, `never` leaves Bend out). Each law is shown in plain words and written only if approved, with a minimal Bend model.
- Setup proposes `BEND_NO_TELEMETRY=1 bend --check-only PROOF.bend` as a verify step when `bend` is on PATH and `PROOF.bend` exists, and adds it to an existing `verify` when `/setup` runs again. If `bend` is missing it says how to install it (`curl -fsSL https://bend-lang.com/install.sh | sh`, no sudo, into `~/.bend`) and never installs it.
- In a `/task`, editing an existing `LAWS.bend` is one of the quality gates (below): high risk, and listed in the completion dialog whatever the review policy; edits to a `LAWS.bend` that was uncommitted when the task started are not flagged. `PROOF.bend` is a verify file like any other: an edit the plan does not name is flagged too.
- An on-request `bend-laws` skill is listed in plan and implement, and the implement prompt and the main session's prompt gain one rule, whatever implement skills the project picked: critical logic is verified against the laws, and `LAWS.bend` is never edited without the user's approval; `/doctor` shows the `bend` version.
- Without a `LAWS.bend` none of this exists outside `/setup`: no prompt text, no skill, no check; `useBend: never` removes the setup offer too. Bend sends a daily version ping unless `BEND_NO_TELEMETRY=1`, which the verify step sets.

## 5. agentlint

`agentlint check --all` is one more `verify` step. It checks the MUST/NEVER rules setup turned into code. If a rule fails:

- the agent gets one attempt to fix the code;
- if the agent thinks the code is right, it records its reason with `agentlint propose`;
- if it fails again, the person decides: fix, or accept. pi shows each finding (rule, file, line, the agent's note) and asks for its own reason; an empty reason sends the rest back to the agent. Each acceptance is recorded with `agentlint approve` and a human actor, because pi has no TTY and may run inside another agent.

agentlint has no warning mode: a configured rule always blocks. So setup picks the lifecycle by what the rule judges: `change` for rules about changes (only the diff against the merge base is judged, existing code is never flagged), `state` for rules about the current code. Findings a `state` rule has in existing code are narrowed by the agent or shown to the person by `setup_finish`, one by one, the same way.

Guards: an agentlint exception always needs the person, even when the rule lets the agent decide. After every bash command and before the gate verifies, lines in `.agentlint/acceptances.jsonl` the person has not seen are shown for approval; declined, or with no one to ask, the file is restored. The model cannot write or edit that file. Commands that open the interactive UI (`review`, `--review`, `--wizard`) are blocked, because they would wait for someone.

## 6. Error correction

The `verify` report returns to the orchestrator with instructions. Pressure rises with each failure:

| Failure | What happens |
|---------|--------------|
| 1st | "Fix it and finish." |
| 2nd | `diagnosing-bugs` skill injected: reproduce, isolate, hypothesize, then touch code. |
| 2nd, too | Switch to the `escalate` model (or `review`, or `setup`) for that attempt. |
| 3rd | The person decides: continue or drop. |

When the same failure comes back (the last two signatures are equal: same failing step and the same output lines the same number of times, times, durations and hex addresses normalized and whitespace collapsed; paths stay), the report from the escalation point on, including `failuresBeforeEscalation: 1`, also carries three premise lines: state the false assumption behind the earlier fixes, name an observation that would contradict it and check it before touching code, and start again from what was observed if it was wrong.

Risk is measured on every pass against the task's `baseCommit` (HEAD when it entered implementing, so commits the agent made still count): `git diff <base>` plus untracked files. Without one it uses the last commit before the task started, and with neither there is no base: the whole tree counts as changed, every test and verify file is touched, and risk is high (`no base`). Never `HEAD`, which would hide commits made during the task. The level is `none`, `low` (over 200 lines or 6 files, no plan, new user decisions; a test file is one in a `test`, `tests`, `__tests__`, `spec`, `e2e` or `__mocks__` directory, or whose name has `test`, `tests` or `spec` as a separated word or CamelCase suffix, such as `a.test.ts`, `a_test.go`, `test_a.py`, `ATest.java`) or `high` (over 600 lines or 15 files, dependencies, migrations, `review.paths`, sensitive zones, or a change to a file that existed before the task and looks like a test or is named by a `verify` command, such as a script path, or `package.json` when a command runs a package-manager script, unless the plan lists it in `files` or a seam: the model may have edited the test or the setup to turn verify green); The `review.*` thresholds tune it. Level and reasons appear in the gate's final summary, and the completion dialog lists those test and verify files before the person accepts. The implement prompt tells the model not to change them unless the ticket asks. A model review is requested when `review.always` is set (it beats `review.never`) or the level reaches `review.minLevel` (default `high`; `off` never reviews), and needs `models.review`; without it the gate warns once per session and runs none. When the policy is `off` (or `review.never`), the gate says "Review not requested" with how to turn it on, and the review is recorded as `not-requested`, which `/cost` and `/metrics` do not count as an avoided review; `skipped-low-risk` is only a diff below an active policy, for a task no review ran on. When requested, a read-only child with the `review` model reviews the diff against the plan, ADRs and `AGENTS.md`, following `pstack-blast-radius`. One round, and never twice for the same diff. If it asks for changes, the cheap model makes them and `verify` checks them, not another paid review. Below the configured level, no review is paid. Without tmux, or on failure, the review is skipped and the person is told.

**Quality gates.** The risk assessment also raises a change to high risk, and lists it in the completion dialog, when: a task that reads as a bug fix (title, body or plan intent) changes source but no test; a test diff removes or edits assertion lines or adds skip/only/xfail/retry markers; or the diff passes `limits.changeCap` lines. These are path and line checks, not language rules. The reviewer's brief also carries the verify commands (it cannot run them; the gate does, in parallel) and fuzzy warnings from scanning added lines for swallowed errors and commented-out code.  `/pr` runs verify before it offers to commit, stops without committing when verify has a new failure (old failures from the baseline still let it commit), and keeps the commit subject within 72 characters.

When the person confirms the task is done (without a UI, a passing verify is the answer; with only old failures left the task stays open and a notice says why), a record goes to `.pi/memory/tasks.jsonl` (versioned). It feeds the planning of future tasks (stage 2). Declined, or left unverified, the task stays open: `/task done` closes it later, `/task cancel` drops it, and both switch back to the model in use before `/task`. A session that starts with a task still open says so once. Every 5 tasks (`limits.retroEvery`; `0` turns it off), a retro runs with the `retro` skill. When the code the verify-app skill covers (`features/coverage.json`) changed since its `sync` commit, the retro prompt also points to `pstack-maintain-verification-skill` (on demand), which ends by setting `sync` to the output of `git rev-parse HEAD`. If the `sync` commit no longer exists, the retro says so and asks to refresh the coverage.

## 7. PR with static checks

`/pr [base]` prepares the branch and the PR with `gh` and the repo's PR template. It attaches the static check results: `verify` commands (with the failures that predate the change, when there are any), agentlint findings, the plan's intent and summary, new ADRs, the risk assessment and `verify-app` evidence when it exists. `/task` does not commit, so when work is uncommitted `/pr` offers to commit it with the task title as the message. The commit includes the versioned `.pi/` state (`workflow.json`, `memory/tasks.jsonl`, `skills/`) and leaves out only what stays on this machine: `task.json`, `metrics/`, `evidence/` and a legacy `contract.json`, the same list `/setup` puts in `.gitignore` (`LOCAL_STATE` in `src/task-state.ts`). Nothing is committed, pushed or opened without the person's explicit confirmation. PR text never names an AI tool.

## 8. PR review in CI

Out of package, but setup prepares it. The same `verify` commands, agentlint included, must run in the project's CI. What passes locally must pass in CI with the same list. If they diverge, setup or the retro fixes it.

## 9. Deploy

Out of package. The project pipeline deploys once the PR is approved.

## 10. Manual verification

Out of package, on purpose. A person has the last word on functionality in the deployed environment. `verify-app` and `.pi/evidence/` make that check short and targeted. They do not replace it.

## Internals

**State.** `.pi/workflow.json` is project state (versioned; keys in the [README table](../README.md#state)). `.pi/task.json` is the active task (local, in `.gitignore` with `.pi/metrics/` and `.pi/evidence/`): `id`, `title`, `ticket`, `status` (`planning` | `implementing` | `done`), `plan`, `spec`, `baseline`, `planChecks`, `allowedExtra`, `baseCommit`, `startedAt`, `completedAt`. The model's write and edit tools cannot change either file.

**Config.** Every option can sit in the user's `<agent dir>/pi-improved.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) and in the project's `.pi/workflow.json`; the project wins. Plain objects merge key by key, arrays and scalars are replaced, and the state keys (`setup`, `verify`, `connectors`...) are read from the project only. `updateManifest` writes the project file alone, so `/models` and `/skills` never copy global values into the repo. The numbers this document quotes (questions, rules, retries, fast path, retro cadence) are the `limits` keys in the README table; a bad value falls back to its default and `/doctor` says so. `computer`, `subagentPanes` and `selfCompact` used to live in `computer.json`, pi's `settings.json` and `self-compact.json`: `legacy-config.ts` copies each into the new file once at startup (only where the key is missing), notifies, and leaves the old file as it was; after that only the new files are read.

**Cost controls.** Verify runs are recorded per task with a kind: baseline (with its duration), progress (runs and failures) and gate (runs, failures, predating failures, premise lines). `/cost` shows the active task's phase, cost and tokens per phase, and the last risk level; `/metrics` covers finished tasks. `contextWarn` and `maxReport` are in the README table. Running `/setup` again on a finished setup warns about the strong-model cost and asks before repeating; the startup offer never fires then.

**Models per phase.** `/models` sets `setup`, `implement`, `review` and `escalate` as `provider/model`. A missing phase uses the session model. The strong model runs once in setup, in the plan check, in the diff review when risky, and on the third fix attempt. Everything else uses the cheap model.

**Skills per phase.** Skills live in `vendor/skills/` and each role gets only the ones it uses (`/skills` changes them; a missing skill is ignored). The implement skills are injected once the plan is approved; the others are in the phase prompt; on-demand skills may be read when the work needs them. The model never picks an injected skill.

| Role | Injected | On demand |
|---|---|---|
| setup | grilling, domain-modeling, pstack-technical-writing, writing-for-agents, pstack-create-verification-skill | research |
| plan | tdd, contract-first | how, architect, codebase-design |
| implement | principles-implement (tdd and contract-first arrive with the approved plan) | handoff |
| diagnose | diagnosing-bugs, principles-diagnose | why, benchmark-checklist, principle-explain-the-number |
| review (read-only subagent) | code-review, pstack-blast-radius, principles-review | none |
| learn | retro, correct | pstack-maintain-verification-skill |
| plan check (subagent) | a short brief (naming rule and five checks), no skills | none |

`interrogate` (a short adversarial pass: every finding needs a command and its output) and `reflect` are opt-in only. The main session also gets a base prompt: the `unslop` skill (when bundled) and two working-style lines. Subagents never get it. `basePrompt: false` in `.pi/workflow.json` turns it off.

**Gates.** All blocking happens in code, on pi events: `agent_before_settle` (contract, verify, review, close), `tool_result` (write count, MCP text as ticket evidence) and `tool_call` (files outside the plan, dependencies, migrations, interactive agentlint commands, and write or edit calls on `.pi/workflow.json` or `.pi/task.json`). `setup_finish` and `task_plan` are always declared, so the tool list never changes and the prompt cache survives phase changes; outside their phase they return an error. The model asks the person through the `ask_user` tool (options plus "Other"); it fails without a UI.

**Subagents.** Children launch via pi-subagent in tmux, read-only (`read,grep,find,ls` plus `codemode`, whose scripts reach only those four: the `mcp__none` entry keeps MCP tools out), with a brief file and a time limit. Inside a child (`PI_SUBAGENT_RUN_DIR`) the extension registers nothing: no setup offers, blocks or questions nobody can see. Their cost goes to the task telemetry. Above the editor, one line per child of the session, plan check and review included: state, current tool, turns, tool calls, model, context tokens and time. A child leaves it 5 minutes after it finishes; `/subagent` still lists it. When pi runs inside tmux (`$TMUX` and `$TMUX_PANE` set), each child gets a pane beside pi (`tmux split-window -d`, so focus stays on pi) attached to its tmux session while it works, so you can watch it or type to steer it; the pane closes when the child goes idle or stops. In Tern, Stencil's terminal, the same happens only if `"subagentPanes": "tern"` is in the global file `pi-improved.json` and `TERN_PANE` is set; it is not detected on its own. `/subagent` picks a child and focuses its pane, or opens one that stays until the child stops; outside tmux and Tern it attaches like pi-subagent's and there is only the widget. Both replace pi-subagent's own widget and `/subagent`, unless pi-subagent is installed in pi itself.

**Pictures.** The `show` tool draws a picture in the chat through the terminal's image protocol (Kitty or iTerm2: Tern, Kitty, Ghostty, WezTerm, iTerm2; elsewhere a one-line placeholder). It takes a PNG, JPEG, GIF or WebP file as is, and renders an SVG file, an HTML file or HTML/SVG markup (mockups, styled tables) with the headless Chromium from Nix (chrome-headless-shell, no system browser needed): the page is measured, then saved as a PNG at twice its size in `~/.pi/agent/renders/`. The model gets only the path, so a picture costs no image tokens. For charts the tool description tells it to plot to a PNG first (matplotlib or similar); for diagrams, to write a ```` ```mermaid ```` block, which pi itself draws as text (flowchart, sequence, class, state, ER).

**Portability.** `pi install git:github.com/OnishellT/pi-improved` is enough. pi-subagent and agentlint are bundled. System requirements that cannot be packaged: Node >= 22.18 and Nix. Nix is mandatory: tmux, git, gh, bash and the headless Chromium (`show` on HTML and SVG, the isolated browser) come from one nixpkgs pinned by `flake.lock`, which `src/nix.ts` reads, so there is a single pin. Each is built or fetched on first use with `nix build --out-link <agent dir>/nix-roots/<nixpkgs rev>/<attr> --print-out-paths` (the link is a GC root, one folder per pin, so a garbage collection cannot delete a path a session uses; delete `nix-roots/` to free them), cached for the process, and its `bin` is put first on the PATH of the command that needs it only (`env PATH=…`; verify keeps the inherited PATH after the Nix dirs). Missing Nix is reported with the install command for the OS from nixos.org/download. `/doctor` prefetches and reports each package. Out of scope: `tern`, Node, the desktop, the browser in relay mode, and ssh (the system's: Nix openssh rejects macOS `UseKeychain`). git over https needs one login, gh's: if the helper configured for github.com is not one Nix git can run (it finds only its own cache/store/netrc by name; macOS `osxkeychain` is in Apple git's system gitconfig, which it never reads), the call gets `-c credential.https://github.com.helper=!<gh>/bin/gh auth git-credential`, never written to disk because store paths change after a GC. `flake.nix` also offers pi itself (`nix profile install github:OnishellT/pi-improved`) on the same pin.

**Module map** (`src/`).

| Group | File | Owns |
|---|---|---|
| Commands | `setup.ts`, `setup-prompt.ts` | `/setup`, `setup_finish`, the setup prompt |
| | `task.ts`, `task-prompt.ts` | `/task`, `task_plan`, plan approval and fast path |
| | `models.ts`, `skills.ts` | `/models`, `/skills`, skill injection and on-demand index |
| | `doctor.ts`, `pr.ts`, `telemetry.ts` | `/doctor`, `/pr`, `/cost` and `/metrics` |
| Gates | `gate.ts` | verify, contract, review, escalation at `agent_before_settle`; `/verify` |
| | `verify.ts`, `policy.ts` | running `verify` steps; agentlint failures and exceptions |
| | `contract.ts`, `plan-check.ts` | verified names; plan check |
| | `risk.ts`, `review.ts` | diff risk and fast path; the review subagent |
| | `triggers.ts`, `guards.ts` | scope, dependency and migration pauses; blocked agentlint and state-file writes |
| | `quality.ts`, `bend.ts` | quality gates (bug fix without a test, weakened tests, change cap, added-line warnings); Bend laws |
| | `verify-app.ts`, `context-guard.ts` | verify-app skill checks and coverage; context notice |
| State | `manifest.ts`, `task-state.ts` | `.pi/workflow.json`, `.pi/task.json`, task memory, defaults |
| | `config.ts`, `legacy-config.ts` | the global file, merge, `limits`; one-time move of the old config files |
| | `learn.ts`, `adr.ts`, `events.ts` | task records and retro; ADR files; events between modules |
| | `discover.ts`, `connectors.ts`, `ui-driver.ts` | repo scan; vetted connectors; GUI driver detection |
| | `ask.ts`, `show.ts`, `base-prompt.ts`, `git.ts` | `ask_user`; `show`; main-prompt additions; git helper |
| | `index.ts`, `abort.ts`, `nix.ts` | extension entry and wiring; stopping working children; Nix packages and the pin |
| Subagents | `bin.ts`, `subagent-ext.ts`, `subagent-view.ts` | bundled CLIs; loading pi-subagent; children widget, tmux or Tern panes, `/subagent` |
| Computer | `computer/` | `/computer`, browser and desktop MCP servers ([COMPUTER.md](COMPUTER.md)) |

## Pending

1. **Implementer subagent** with trimmed context (stage 3). Today implementation runs in the same pi session with the `implement` model and the plan as contract; the existing subagents are read-only (plan check, diff review). The surrounding pieces (gates, pauses, verification) will not change.
2. **Evaluation with more tasks**, plus a variant with an interface hint, to measure quality on the full flow.
