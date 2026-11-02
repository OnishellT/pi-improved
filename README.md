# pi-improved

A pi extension that sets up your project so cheap models work with good context. The cheap model implements, code gates each step, and a strong model and you step in only where they add value.

```sh
pi install git:github.com/OnishellT/pi-improved
```

Then, in your project:

1. `/doctor` checks Node, Nix, the logins and the models. The first run downloads the Nix packages.
2. `/models` picks a model per phase. Do it first if you want a stronger model for setup, or a review model (without one, no review runs). `/setup` says which model it runs on.
3. `/setup` scans the repo, asks a few questions, and writes `AGENTS.md`, skills, ADRs and the verify steps. Pi offers it when you open a project without setup.
4. `/task <what to do>` plans, implements, verifies, and asks you to confirm.

Every command is in [Commands](#commands). The full flow is in [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Requirements

- Linux or macOS, Node >= 22.19, git and npm on your PATH.
- [Nix](https://nixos.org/download/), required for `/setup`, verify and the features below. It provides tmux (the review and plan-check subagents), git, gh, bash and the headless Chromium (`show` on HTML or SVG, the isolated browser), all from the nixpkgs pinned in `flake.lock`. Without it `/setup` stops, verify does not run, and the other features are off. Each says so with the install command for your OS, and `/doctor` reports it.
  - Linux and WSL (needs systemd): `curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --daemon`
  - macOS: `curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh`
  - Intel Macs have no headless Chromium in nixpkgs, so `show` on HTML and the isolated browser do not work there.
- For pushes and `/pr`: one login, `gh auth login`. Without gh on your PATH: `nix --extra-experimental-features 'nix-command flakes' run nixpkgs#gh -- auth login`. Your git config is never changed.

Not packaged: your ssh, `tern`, the desktop tools, and the browser `/computer` drives in relay mode. pi-subagent and agentlint ship with the package.

Pi itself, pinned with Node 22, git, tmux and gh, from this repo's flake (x86_64-linux, aarch64-linux, aarch64-darwin):

```sh
nix profile install github:OnishellT/pi-improved
pi install git:github.com/OnishellT/pi-improved
```

To try it from a clone: `npm install`, then `pi -e <clone>`. Run `npm install` again after every pull.

## Commands

| Command | What it does | When |
|---|---|---|
| `/doctor` | Checks the environment: Node, Nix and its packages, git and gh logins, subagent, agentlint and Bend when used, and that each configured model is available. Also checks the skill phases and names, and the desktop when `/computer` turns it on. Lists the config files in effect, bad values and keys it did not read (`mode` is a legacy key, tolerated and not read). Shows a status while it runs. At session start, a warning names the checks that fail (config problems or something missing) and says to run `/doctor`. | After install, and when something fails. |
| `/models [project]` | Picks a model per phase (`setup`, `implement`, `review`, `escalate`). Pick a phase, then its model, until Done. Esc saves nothing. Saved in the global file, unless the project file sets that phase; `/models project` saves for this project only. | Before `/setup`, or when no review model is set. |
| `/setup` | Scans the repo, asks the minimum, then has the model write `AGENTS.md`, domain skills, ADRs, a verify-app skill and the `verify` steps. You approve the result. | Once per repo. |
| `/task <text \| KEY-1 \| spec.md>` | Plans and implements a task, then verifies it. `/task` alone shows the task and what to do next. `continue`, `done` and `cancel` act on it. | For any change you want planned and gated. |
| `/verify` | Runs the project's `verify` steps by hand. Says "Verify did not run" when Nix is missing or fails, or `.pi/workflow.json` cannot be read. | After a fix, before `/task done`. |
| `/pr [base]` | Prepares the branch and the PR: summary, verify report, risk, ADRs, decisions. Commits, pushes and opens only after you confirm. | When the task is done. |
| `/retro [n]` | Reviews the last finished tasks and proposes edits to `AGENTS.md`, ADRs or skills. Writes nothing without your yes. | After the reminder, or whenever you want. |
| `/cost` | Cost, tokens and risk of the active task. With no active task, the latest finished tasks. | During a task. |
| `/metrics` | Cost, tokens, time and review of the last 10 finished tasks, and how their plan checks ended (ok, fix, skipped: not run or no verdict). | To compare tasks. |
| `/skills` | Picks the skills of one phase at a time. Esc leaves without saving. | To tune what each phase reads. |
| `/computer` | Picks the browser and desktop the agent can drive. Off until you choose ([docs/COMPUTER.md](docs/COMPUTER.md)). | When the agent must use a browser or desktop. |
| `/subagent` | Shows a subagent of this session: focuses or opens its pane in tmux or Tern. | To watch or steer a review or plan check. |
| `/self-compact-info` | Shows the compaction thresholds and the context use. | To check the thresholds. |
| `/self-compact-now [note]` | Compacts now with the configured summary rules and your note. Does not resume. | Before a new piece of work. |

The usage report script (cost per day, model and subagent, from pi's session files) is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#scripts).

### Tools the agent gets

- `ask_user`: asks you up to 5 questions at once, each with 2-4 options (recommended first) or open. Without a UI it tells the agent to choose and say so; while planning a task, pi takes the recommended option.
- `task_plan`: records the plan of the active task. `setup_finish`: ends `/setup`. `understanding_done`: ends the understanding check.
- `show`: shows a picture in the chat (images, charts it plots, HTML or SVG mockups). Terminals with the Kitty or iTerm2 image protocol draw it: Tern, Kitty, Ghostty, WezTerm, iTerm2, not inside tmux. Elsewhere, with pi's `terminal.showImages` off, and in `pi -p`, the picture is saved and the agent is told you saw only its path. In RPC mode the client gets the file.
- `self_compact`: ends the turn so pi compacts and the agent resumes.
- With `/computer`: the MCP servers `browser`, `my-browser` and `desktop`.

## How a task runs

The plan has no approval dialog. Its open questions are asked while planning; Esc on one pauses the plan, and `/task continue` resumes it. Once the plan passes the gates, the agent implements it.

At the end, code runs the `verify` steps. When the diff is risky enough (`review.minLevel`, default `high`) and a review model is set, a read-only review starts alongside verify. A failing verify goes back to the agent: the 2nd failure diagnoses, the 3rd moves to the `escalate` model, and after the retries you decide.

The done dialog lists every file the task changed (ignored files left out, as in a commit), with its status and +/- lines, and one line on the risk and the review. You confirm, then an understanding check asks 2-3 questions about the change (`understanding`; answer "skip" to skip it). Without a UI (print or JSON mode) there is no dialog and no understanding check: a verified task closes on its own, and a run that ends with verify red writes one line to stderr and exits with code 1. `/task done` closes the task by hand, `/task cancel` drops it. Every 5 finished tasks a notice suggests `/retro`.

## Self-compaction

The agent can end its turn with `self_compact` and a handoff note. Pi then compacts and resumes the agent on its own. `/compact` (pi's own) and `/self-compact-now` never resume.

- Thresholds: notice, warning and force, default 75%, 85% and 90% of the context. At the force threshold the next tool call is blocked until the agent compacts.
- Pi's footer stays. From the notice threshold on, a status entry reads `context 77% (notice) · compacts at 90%`.
- When a compaction fails, the agent resumes with the error. After two failures in a row, compaction is off and the status reads `compaction off after 2 failures (run /compact to retry)`. A compaction that succeeds turns it back on.
- `/self-compact-now [note]` uses the configured summary rules (`prompt`) plus your note. `/compact [instructions]` does not use them. If a compaction is already running, `/self-compact-now` says so and does nothing.

Flags: `--compact-notice`, `--compact-warning`, `--compact-force` (token counts or percentages), `--compact-buffer` (tokens kept free below the model limit, such as `32k`, default 0) and `--compact-prompt` (summary instructions). The `selfCompact` key sets the same per model. Details: [docs/WORKFLOW.md](docs/WORKFLOW.md#self-compaction).

## Config

Two files hold the options:

- `.pi/workflow.json` is the project's. It is committed to git, and it also holds the state `/setup` writes.
- `<agent dir>/pi-improved.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) is yours, for every project. It takes any key of the table below except the state keys: `version`, `setup`, `startedAt`, `completedAt`, `verify`, `agentlint`, `agentlintStep`, `agentlintDeclined`, `connectors`, `declinedConnectors`. `language` may sit there as the default for every new `/setup`; the project's value wins. `/models` and `/computer` write to it.

The project file wins over the global one. Plain objects merge key by key (`models`, `review`, `limits`, `limits.fastPath`, `skills`, `selfCompact`); arrays and scalars are replaced. `/setup` and `/skills` write the project file only, and only what changed, so your global values are not copied into the repo. The one exception is `language`: `/setup` records the language it used in the project file. `/models` writes the global file, unless the project file already sets that phase or you run `/models project`. A `null` in the project file unsets a value the global file sets (`"models": { "review": null }` is what `/models project` writes when you turn Review off for this project).

A bad `limits` value is dropped in its own file, so it falls back to the global one, then to the default. Other keys are not checked per file: a bad project value there replaces the global one and is read as it is, so it can turn a feature off or make it fail (an invalid `review.minLevel` turns the diff review off). Run `/doctor` after editing either file. A global file that is not valid JSON counts as empty, with a notice at session start. `/doctor` names the file that holds a bad preference (wrong type or out of range; `language` is not checked), and reports keys it did not read: unknown keys in `.pi/workflow.json` (a typo such as `modles`), state keys in the global file, and `computer` or `subagentPanes` in a project file. Each note names the file, and says to rename or remove an unknown or state key. Paths show relative to the project, or with `~`. The agent's write and edit tools cannot change either file.

Old config files are moved in once at startup. `computer.json` and `self-compact.json` in the agent dir are renamed to `<name>.migrated`. A project's `.pi/self-compact.json` is copied, and the notice asks you to delete it. `subagentPanes` in pi's `settings.json` is copied, and the notice asks you to remove it there.

`.pi/workflow.json`:

```json
{ "version": 1, "setup": "done", "language": "English", "verify": ["npm run test"], "connectors": [{ "id": "jira", "mcp": { "url": "…" } }] }
```

Every key the code reads. `/setup` writes the state keys, `/models`, `/skills` and `/computer` write theirs, and you edit the rest by hand. The keys from `language` on may also sit in the global file.

| Key | Type | Default | Effect |
|---|---|---|---|
| `version` | `1` | `1` | Format version. |
| `setup` | `pending` \| `running` \| `done` | `pending` | Setup state. Gates run only when `done`. Older versions wrote `declined`; it is still read. "Don't ask again" on the setup offer is now kept for you only, in `<agent dir>/pi-improved-state.json`, never in the repo. |
| `startedAt`, `completedAt` | ISO date | set by `/setup` | When setup started and finished. |
| `verify` | string[] | `[]` | Shell commands run in order at the end of a task and by `/verify`. With none, nothing checks the change: the done dialog says so, and without a UI the task stays open for `/task done`. |
| `agentlint` | string | none | agentlint command prefix when the project enforces its rules, e.g. `pnpm agentlint`. |
| `agentlintStep` | string | set by `/setup` | The verify step that runs agentlint; its findings get per-finding approval. |
| `agentlintDeclined` | boolean | none | `true` once you said no to agentlint rules in `/setup`; it does not ask again. `useAgentlint: "always"` still adds them. |
| `connectors` | `{ id, mcp?: { url } }[]` | `[]` | Ticket trackers enabled in setup. |
| `declinedConnectors` | string[] | none | Connectors you said no to in `/setup`; it does not ask about them again. Remove an id to be asked again. |
| `language` | string | global file, else asked in `/setup` | Language of setup questions and docs. Set it in the global file to skip the question in every repo. |
| `models` | `{ setup, implement, review, escalate }` | see effect | `provider/model` per phase, set with `/models`. A missing `setup` or `implement` uses the session model. `escalate` falls back to `review`, then `setup`. `review` has no fallback: unset means no diff review (`/models` shows it as Off). |
| `skills` | `{ <phase>: string[] }` | built-in lists | Skills injected per phase. Phases: `setup`, `plan`, `implement`, `diagnose`, `review`, `learn`. Set with `/skills`. |
| `skillsOnDemand` | `{ <phase>: string[] }` | built-in lists | Skills listed as a one-line index the agent reads only if needed. |
| `useAgentlint` | `ask` \| `always` \| `never` | `ask` | Whether `/setup` adds agentlint rules (Node projects): `ask` asks, `always` adds them without asking, `never` neither asks nor enforces them. |
| `useBend` | `ask` \| `always` \| `never` | `ask` | Whether `/setup` offers to record pure-logic invariants as Bend laws (`LAWS.bend`): `ask` asks, `always` drafts them without asking first, `never` leaves Bend out. A project that already has `LAWS.bend` is unaffected. |
| `basePrompt` | boolean | `true` | `false` removes the `unslop` skill and working-style lines from the main prompt. |
| `maxReport` | number | `4000` | Characters of failing-step output kept in a verify report. Minimum 200. |
| `review.minLevel` | `off` \| `low` \| `high` | `high` | Risk level from which a model review runs. `off` never reviews and is reported as "not requested". Needs `models.review`. |
| `review.always` | boolean | `false` | Always review, always check the plan. Beats `never`. Needs `models.review` for the diff review. |
| `review.never` | boolean | `false` | Never review and never check the plan. |
| `review.plan` | boolean | unset | `true`: check every plan. `false`: never. Unset: only when the plan is risky. |
| `review.paths` | string[] | `[]` | Globs that count as high risk. |
| `review.maxLines`, `review.maxFiles` | number | `200`, `6` | Above these the diff is `low` risk. |
| `review.highLines`, `review.highFiles` | number | `600`, `15` | Above these the diff is `high` risk. `limits.changeCap` (default 500) also makes a diff high risk, and it fires first at the defaults: raise both to loosen the review trigger. |
| `limits.interviewQuestions` | integer >= 1 | `12` | Questions the `/setup` interview asks at most. |
| `limits.agentlintRules` | integer >= 1 | `3` | agentlint rules offered at first in `/setup`. |
| `limits.verifyRetries` | integer >= 0 | `3` | Automatic retries after a failed verify (and after contract misses) before you are asked. The escalated attempt is not held back by it. |
| `limits.failuresBeforeEscalation` | integer >= 1 | `3` | Failed verifies after which the `escalate` model takes the attempt, even past `verifyRetries`. The 2nd failure diagnoses on the current model; at 2 or lower both happen together. |
| `limits.planChecks` | integer >= 0 | `1` | Paid plan checks per task. `0` turns them off. |
| `limits.retroEvery` | integer >= 0 | `5` | Shows a `/retro` reminder every this many finished tasks, and sets how many tasks `/retro` reviews. `0` turns the reminder off. |
| `limits.verifyEvery` | integer >= 0 | `0` | Off by default. Set a number to turn on progress checks: every this many writes while implementing, the first `verify` command runs (60 s cap) and its result is appended to the tool result. It is off for the rest of the task once a run takes 30 s or more or times out. |
| `limits.changeCap` | integer >= 1 | `500` | Changed lines (lockfiles and generated or vendored paths excluded) above which a change is high risk and gets a model review. See also `review.highLines`. |
| `limits.fastPath.files`, `.interface`, `.decisions` | integer >= 0 | `8`, `6`, `2` | Largest plan (files, interface entries, decisions) the "Plan recorded" notice calls small; above it, the size is listed as a risk reason. |
| `computer` | `{ browser?, desktop? }` | off | Set by `/computer` ([docs/COMPUTER.md](docs/COMPUTER.md)). Global file only: a repo cannot choose what the agent drives. |
| `subagentPanes` | `tern` | tmux only | `tern` opens subagent panes in Tern too. Global file only. |
| `selfCompact` | `{ default?, models? }` | see [Self-compaction](#self-compaction) | Thresholds per model: `{ default: { notice?, warning?, force?, buffer?, prompt? }, models: { "provider/model": {...} } }`. |
| `understanding` | `off` \| `end` \| `plan+end` | `plan+end` | Inside `/task`: `plan+end` asks for your approach to the key decisions before the plan and runs a teach-back after verify; `end` only the teach-back; `off` neither. |

`.pi/task.json` is the active task. It is local, and setup adds it to `.gitignore`.

## Development

Tests, scripts and the pull request reviewer: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
