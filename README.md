# pi-improved

Automatic project setup for Pi, so cheap models work with good context. The cheap model implements, code gates each step, and the strong model and the person step in only where they add value.

## Install

Requirements: Node >= 22.18, git and **tmux** (reviews run in tmux sessions). The rest ships with the package, including the [pi-subagent](https://github.com/badlogic/pi-subagent) CLI and [agentlint](https://github.com/aurelienbobenrieth/agentlint). A `subagent` already on the PATH wins.

```sh
pi install git:github.com/OnishellT/pi-improved
```

To try without installing: `npm install`, then `pi -e ~/projects/pi-improved`.

## Use

In your project:

1. `/setup`: scan the repo, ask the minimum, then have the model write `AGENTS.md`, domain skills, ADRs and a verification skill. Pi offers it when you open a project without setup.
2. `/models`: pick a model per phase (`setup`, `implement`, `review`, `escalate`). Saved in `.pi/workflow.json`.
3. `/task <description or PAY-142>`: plan, approve once (small, low-risk plans skip the dialog but pass the same gates), implement. Code gates the end on `verify`, then a read-only review runs if the diff is risky.
4. `/doctor`: check Node, subagent, agentlint, tmux, git, and that the configured models are available. If one is missing, run `/login <provider>`.

`/verify` runs verification by hand. `/skills` picks the skills injected per phase. `/computer` picks the browser and desktop the agent can drive, off until you choose ([docs/COMPUTER.md](docs/COMPUTER.md)).

Stages, gates, checks and internals: [docs/WORKFLOW.md](docs/WORKFLOW.md).

## State

`.pi/workflow.json` (versioned in git):

```json
{ "version": 1, "setup": "done", "language": "Español", "verify": ["npm run test"], "connectors": [{ "id": "jira", "mcp": { "url": "…" } }] }
```

Optional `"mode": "direct" | "flow"` (default `direct`): in `direct`, `/task` is optional and recommended for risky changes; `flow` makes it the main route.

`.pi/task.json` is the active task. It is local, and setup adds it to `.gitignore`.

## Measuring cost

`node scripts/usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root ~/.pi/agent]` sums
`usage.cost.total` from the Pi session files and prints cost per day, per model and per subagent, plus the share
of turns by context size (big contexts are where cost hides). Unreadable or unpriced data is listed as warnings,
never as an error. Compare two periods with `--since/--until`.

## Development

```sh
npm test
```
