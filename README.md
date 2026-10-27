# pi-improved

Automatic project setup for Pi, so cheap models work with good context. The cheap model implements, code gates each step, and the strong model and the person step in only where they add value.

## Install

Requirements: Linux or macOS, Node >= 22.18, git, bash and **tmux** (the review and plan-check subagents run in tmux sessions). The rest ships with the package, including the [pi-subagent](https://github.com/badlogic/pi-subagent) CLI and [agentlint](https://github.com/aurelienbobenrieth/agentlint). A pi-subagent installed in pi itself wins over the bundled one and keeps its own widget and `/subagent`.

```sh
pi install git:github.com/OnishellT/pi-improved
```

To try without installing: `npm install`, then `pi -e ~/projects/pi-improved`.

## Use

In your project:

1. `/setup`: scan the repo, ask the minimum, then have the model write `AGENTS.md`, domain skills, ADRs and a verification skill. Pi offers it when you open a project without setup.
2. `/models`: pick a model per phase (`setup`, `implement`, `review`, `escalate`). Saved in `.pi/workflow.json`.
3. `/task <description or PAY-142>`: plan, approve once (small, low-risk plans skip the dialog but pass the same gates), implement. Code gates the end on `verify`, then a read-only review runs if the diff is risky.
4. `/doctor`: check Node, subagent, tmux, git, agentlint when the project uses it, and that each configured model is listed for a provider you are logged in to (if one is missing, run `/login <provider>`). It does not call the models, so one your account cannot use only fails on its first call.

`/pr [base]` prepares the branch and the PR with the static check results. `/cost` shows the active task's spend and `/metrics` the finished tasks'. `/verify` runs verification by hand. `/skills` picks the skills injected per phase. `/computer` picks the browser and desktop the agent can drive, off until you choose ([docs/COMPUTER.md](docs/COMPUTER.md)). The agent can show pictures in the chat: images, charts it plots, and HTML or SVG mockups (those need Chromium or Chrome).

Stages, gates, checks and internals: [docs/WORKFLOW.md](docs/WORKFLOW.md).

## State

`.pi/workflow.json` (versioned in git):

```json
{ "version": 1, "setup": "done", "language": "English", "verify": ["npm run test"], "connectors": [{ "id": "jira", "mcp": { "url": "…" } }] }
```

Every key the code reads. Setup and `/models` write most of them; the rest you edit by hand.

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
| `basePrompt` | boolean | `true` | `false` removes the `unslop` skill and working-style lines from the main prompt. |
| `maxReport` | number | `4000` | Characters of failing-step output kept in a verify report. Minimum 200. |
| `contextWarn` | number | `150000` | Context tokens at which a one-time notice suggests `/compact`. `0` turns it off. |
| `review.minLevel` | `off` \| `low` \| `high` | `off` | Risk level from which a model review runs. Needs `models.review`. |
| `review.always` | boolean | `false` | Always review, always check the plan. Beats `never`. Needs `models.review` for the diff review. |
| `review.never` | boolean | `false` | Never review and never check the plan. |
| `review.plan` | boolean | unset | `true`: check every plan. `false`: never. Unset: only when the plan is risky. |
| `review.paths` | string[] | `[]` | Globs that count as high risk. |
| `review.maxLines`, `review.maxFiles` | number | `200`, `6` | Above these the diff is `low` risk. |
| `review.highLines`, `review.highFiles` | number | `600`, `15` | Above these the diff is `high` risk. |

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

pi-subagent is pinned to a commit in `package.json`; bump the sha deliberately. `package-lock.json` is gitignored on purpose. Module map: [docs/WORKFLOW.md](docs/WORKFLOW.md#internals).
