# pi-improved

Automatic project setup for Pi, so cheap models work with good context. The cheap model implements, code gates each step, and the strong model and the person step in only where they add value.

## Install

Requirements: Linux or macOS, Node >= 22.18 and **[Nix](https://nixos.org/download/)**. Nix is mandatory: tmux (the review and plan-check subagents run in tmux sessions), git, gh, bash and the headless Chromium for `show` and the isolated browser come from one pinned nixpkgs (the rev in `flake.lock`), downloaded on first use and cached by Nix, so nothing else has to be installed or kept in step. On Linux and WSL (needs systemd): `curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --daemon`. On macOS: `curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh`. Intel Macs have no headless Chromium in nixpkgs, so `show` on HTML and the isolated browser are unavailable there. Without Nix, those features say so with the command for your OS, and `/doctor` reports it. Your own ssh stays the system's, `tern` and the desktop tools are not packaged, and the browser `/computer` can drive in relay mode is the one you installed. The rest ships with the package, including the [pi-subagent](https://github.com/badlogic/pi-subagent) CLI and [agentlint](https://github.com/aurelienbobenrieth/agentlint). A pi-subagent installed in pi itself wins over the bundled one and keeps its own widget and `/subagent`.

```sh
pi install git:github.com/OnishellT/pi-improved
```

git over https uses one login, `gh auth login`: when your git has no helper Nix git can run for github.com (a helper given by name such as `libsecret` or `osxkeychain` is not found by it), pi-improved passes gh's helper on that one call and writes nothing to your git config.

To get pi itself, pinned and with its tools, from this repo's flake (nixpkgs `pi-coding-agent` with Node 22, git, tmux and gh on its PATH; x86_64-linux, aarch64-linux, aarch64-darwin):

```sh
nix profile install github:OnishellT/pi-improved
pi install git:github.com/OnishellT/pi-improved
```

Both ways work: the flake is for a stable pi, and pi's own latest release does too.

To try without installing: `npm install`, then `pi -e ~/projects/pi-improved`.

## Use

In your project:

1. `/setup`: scan the repo, ask the minimum, then have the model write `AGENTS.md`, domain skills, ADRs and a verification skill. Pi offers it when you open a project without setup.
2. `/models`: pick a model per phase (`setup`, `implement`, `review`, `escalate`). Saved in `.pi/workflow.json`.
3. `/task <description or PAY-142>`: plan, approve once (small, low-risk plans skip the dialog but pass the same gates), implement. Code gates the end on `verify`, then a read-only review runs if the diff is high risk (set `models.review`; `review.minLevel` changes the level). `/task done` closes the task by hand, `/task cancel` drops it.
4. `/doctor`: show which config files are in effect, report limits and keys that were not read, check Node, subagent, Nix and the packages it provides (tmux, git, gh, bash, the headless browser; the first run downloads them), the git login for github.com, agentlint when the project uses it, and that each configured model is listed for a provider you are logged in to (if one is missing, run `/login <provider>`). It does not call the models, so one your account cannot use only fails on its first call.

`/pr [base]` prepares the branch and the PR with the static check results. `/cost` shows the active task's spend and `/metrics` the finished tasks'. `/verify` runs verification by hand. `/skills` picks the skills injected per phase. `/computer` picks the browser and desktop the agent can drive, off until you choose ([docs/COMPUTER.md](docs/COMPUTER.md)). The agent can show pictures in the chat: images, charts it plots, and HTML or SVG mockups (those use the headless Chromium from Nix).

### Self-compaction

The `self-compact` extension tracks context usage and lets the agent request compaction with a handoff note. Configure soft notice, warning, and hard-limit thresholds with `--compact-notice`, `--compact-warning`, `--compact-force` (token counts or percentages, default 75%/85%/90%), and `--compact-buffer` for tokens kept free below the model limit (a token count such as `32k`, default 0). Per-model and project defaults are the `selfCompact` key of `~/.pi/agent/pi-improved.json` and of the project's `.pi/workflow.json` (schema: `{ default: { notice?, warning?, force?, buffer?, prompt? }, models: { "provider/model": {...} } }`); each file's profile for the model is resolved first, then the project's values win. The old `self-compact.json` files (global and `.pi/`) are copied into those keys once at startup and no longer read. The footer shows context usage and threshold markers. By default the summary keeps the latest request word for word and what failed, and drops tool output the work already used; a `prompt` replaces these rules. Use `/self-compact-info` to check current thresholds and `/self-compact-now [note]` to compact manually. Enforcement is skipped, with a one-time error, when thresholds are misordered, the buffer is not smaller than the context window, or force is at or above the context window minus the buffer. After a failed forced compaction it does not force again until usage drops below the force threshold.

Stages, gates, checks and internals: [docs/WORKFLOW.md](docs/WORKFLOW.md).

## State

Two files hold the options:

- `.pi/workflow.json` (versioned in git) is the project's. It also holds the state `/setup` writes.
- `<agent dir>/pi-improved.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) is yours, for every project. It takes any key of the table below except the state keys (`version`, `setup`, `language`, `startedAt`, `completedAt`, `verify`, `agentlint`, `connectors`), which belong to one repo and are ignored there. `/computer` writes to it.

The project file wins over the global one. Plain objects merge key by key (`models`, `review`, `limits`, `limits.fastPath`, `skills`, `selfCompact`); arrays and scalars are replaced. Commands that save (`/setup`, `/models`, `/skills`) write the project file only, and only what changed, so your global values are not copied into the repo. A `null` in the project file unsets a value the global file sets (`"models": { "review": null }` is what `/models` writes when you pick the session model for that phase). A bad `limits` value is dropped in its own file, so a bad project value falls back to the global one, then to the default. A global file that is not valid JSON counts as empty, with a notice at session start. `/doctor` lists both files, names the file that holds a bad value, and reports what it did not read, including `computer` or `subagentPanes` set in a project file (only the global file is read for those). The agent's write and edit tools cannot change the global file.

`.pi/workflow.json`:

```json
{ "version": 1, "setup": "done", "language": "English", "verify": ["npm run test"], "connectors": [{ "id": "jira", "mcp": { "url": "…" } }] }
```

Every key the code reads. Setup and `/models` write most of them; the rest you edit by hand. The keys from `mode` on may also sit in the global file.

| Key | Type | Default | Effect |
|---|---|---|---|
| `version` | `1` | `1` | Format version. |
| `setup` | `pending` \| `running` \| `done` \| `declined` | `pending` | Setup state. Gates run only when `done`. |
| `language` | string | asked in `/setup` | Language of setup questions and docs. |
| `startedAt`, `completedAt` | ISO date | set by `/setup` | When setup started and finished. |
| `verify` | string[] | `[]` | Shell commands run in order at the end of a task and by `/verify`. No commands, no gate. |
| `agentlint` | string | none | agentlint command prefix when the project enforces its rules, e.g. `pnpm agentlint`. |
| `connectors` | `{ id, mcp?: { url } }[]` | `[]` | Ticket trackers enabled in setup. |
| `mode` | `direct` \| `flow` | `direct` | `direct`: `/task` is optional, recommended for risky changes. `flow`: `/task` is the main route. |
| `models` | `{ setup, implement, review, escalate }` | session model | `provider/model` per phase, set with `/models`. `escalate` falls back to `review`, then `setup`. A model review needs `models.review`. |
| `skills` | `{ <phase>: string[] }` | built-in lists | Skills injected per phase. Phases: `setup`, `plan`, `implement`, `diagnose`, `review`, `learn`. Set with `/skills`. |
| `skillsOnDemand` | `{ <phase>: string[] }` | built-in lists | Skills listed as a one-line index the agent reads only if needed. |
| `useAgentlint` | `ask` \| `always` \| `never` | `ask` | Whether `/setup` adds agentlint rules (Node projects): `ask` asks, `always` adds them without asking, `never` neither asks nor enforces them. |
| `useBend` | `ask` \| `always` \| `never` | `ask` | Whether `/setup` offers to record pure-logic invariants as Bend laws (`LAWS.bend`): `ask` asks, `always` drafts them without asking first, `never` leaves Bend out. A project that already has `LAWS.bend` is unaffected. |
| `basePrompt` | boolean | `true` | `false` removes the `unslop` skill and working-style lines from the main prompt. |
| `maxReport` | number | `4000` | Characters of failing-step output kept in a verify report. Minimum 200. |
| `contextWarn` | number | `150000` | Context tokens at which a one-time notice suggests `/compact`. `0` turns it off. |
| `review.minLevel` | `off` \| `low` \| `high` | `high` | Risk level from which a model review runs. `off` never reviews and is reported as "not requested". Needs `models.review`. |
| `review.always` | boolean | `false` | Always review, always check the plan. Beats `never`. Needs `models.review` for the diff review. |
| `review.never` | boolean | `false` | Never review and never check the plan. |
| `review.plan` | boolean | unset | `true`: check every plan. `false`: never. Unset: only when the plan is risky. |
| `review.paths` | string[] | `[]` | Globs that count as high risk. |
| `review.maxLines`, `review.maxFiles` | number | `200`, `6` | Above these the diff is `low` risk. |
| `review.highLines`, `review.highFiles` | number | `600`, `15` | Above these the diff is `high` risk. |
| `limits.interviewQuestions` | integer >= 1 | `12` | Questions the `/setup` interview asks at most. |
| `limits.agentlintRules` | integer >= 1 | `3` | agentlint rules offered at first in `/setup`. |
| `limits.verifyRetries` | integer >= 0 | `2` | Automatic retries after a failed verify (and after contract misses) before the person is asked. |
| `limits.failuresBeforeEscalation` | integer >= 1 | `2` | Failed verifies after which the `escalate` model takes the attempt. |
| `limits.planChecks` | integer >= 0 | `1` | Paid plan checks per task. `0` turns them off. |
| `limits.retroEvery` | integer >= 0 | `5` | A retro every this many finished tasks. `0` turns it off. |
| `limits.verifyEvery` | integer >= 0 | `5` | While implementing, every this many writes the first `verify` command runs (60 s cap) and its result is appended to the tool result. It is off when that command took 30 s or more before the change. `0` turns it off. |
| `limits.changeCap` | integer >= 1 | `500` | Changed lines (lockfiles and generated or vendored paths excluded) above which a change is high risk and gets a model review. |
| `limits.fastPath.files`, `.interface`, `.decisions` | integer >= 0 | `8`, `6`, `2` | Largest plan (files, interface entries, decisions) that skips the approval dialog. |
| `computer` | `{ browser?, desktop? }` | off | Set by `/computer` ([docs/COMPUTER.md](docs/COMPUTER.md)). Global file only: a repo cannot choose what the agent drives. |
| `subagentPanes` | `tern` | tmux only | `tern` opens subagent panes in Tern too. Global file only. |
| `selfCompact` | `{ default?, models? }` | see Self-compaction | Self-compact thresholds per model. |

A `limits` value that is not a whole number in range falls back to its default, and `/doctor` reports it.

`.pi/task.json` is the active task. It is local, and setup adds it to `.gitignore`. The model's write and edit tools cannot change either file; the extension owns them.

## Measuring cost

`node scripts/usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root ~/.pi/agent]` sums
`usage.cost.total` from the Pi session files and prints cost per day, per model and per subagent, plus the share
of turns by context size (big contexts are where cost hides). Unreadable or unpriced data is listed as warnings,
never as an error. Compare two periods with `--since/--until`.

## Development

Node >= 22.18 runs the `.ts` sources and tests directly, no build step.

```sh
npm test            # node --test test/*.test.ts
npm run typecheck   # tsc -p .
pi -e .             # try the extension from this checkout
```

Scripts in `scripts/`:

- `postinstall.mjs`: copies the pi-subagent CLI out of `node_modules` into `.bundled/` (Node will not run TypeScript from `node_modules`). Warns on failure, never fails the install.
- `usage-report.mjs`: the cost report above.
- `skill-tokens.mjs [--json]`: skill sizes per phase and per skill.
- `contract-check.mjs [contract]`: checks `.pi/contract.json` against the code; exit 0 means the contract is met.
- `review-pr.ts <pr>`: the local pull request reviewer, below.

### Reviewing pull requests

`npm run review -- <pr> [--dry-run] [--force]` (run from an up-to-date `main` checkout) reviews a PR with pi and posts
one GitHub review: inline comments, a summary and a confidence score from 1 (must not merge) to 5 (safe to merge).
The reviewer reads the PR head in a throwaway worktree, read-only, with an empty home and no secrets in its environment.
Its context is `README.md`, `docs/*.md`, any `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`, the PR text, the linked
issue, earlier review threads and the diff. Follow-up rounds judge only what changed since the last reviewed commit
(a rebase onto a newer base or a rewritten history makes the round a full review, and the summary says so);
a head that already has a review is skipped, and a fourth round needs `--force` unless the last review had confidence 4 or more. Markdown-only PRs are skipped (unless an earlier review is waiting on the code changed since)
by design (there is no code to review).
`--dry-run` prints the review instead of posting it, and it ignores both gates.

It needs pi signed in to the `openai` provider. Defaults: model `gpt-6.1-terra`, thinking `xhigh`; override with
`REVIEW_MODEL` and `REVIEW_THINKING`. It keeps its own pi profile in `~/.pi/reviewer-pi-improved` (`REVIEW_PI_DIR`),
rebuilt from `scripts/review/pi-settings.json`, with `auth.json` symlinked from `~/.pi/agent`. The prompt and
settings are read from the PR's base branch, so a PR cannot change the reviewer that judges it.

pi-subagent is pinned to a commit in `package.json`; bump the sha deliberately. `package-lock.json` is gitignored on purpose. Module map: [docs/WORKFLOW.md](docs/WORKFLOW.md#internals).
