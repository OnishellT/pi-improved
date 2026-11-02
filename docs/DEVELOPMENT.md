# Development

Node >= 22.19 runs the `.ts` sources and tests directly, with no build step.

```sh
npm test            # node --test test/*.test.ts
npm run typecheck   # tsc -p .
pi -e .             # try the extension from this checkout
```

pi-subagent is pinned to a commit in `package.json`; bump the sha on purpose. It is a [fork](https://github.com/OnishellT/pi-subagent) that passes `PI_CODING_AGENT_DIR` to its children. A pi-subagent installed in pi itself wins over the bundled one and keeps its own widget and `/subagent`. `package-lock.json` pins the rest. CI runs `npm ci`, the type check and the tests. Module map: [WORKFLOW.md](WORKFLOW.md#internals).

## Scripts

Scripts in `scripts/`:

- `postinstall.mjs`: copies the pi-subagent CLI out of `node_modules` into `.bundled/` (Node will not run TypeScript from `node_modules`). Warns on failure, never fails the install.
- `usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root ~/.pi/agent]`: sums `usage.cost.total` from pi's session files. It prints cost per day, per model and per subagent, and the share of turns by context size (big contexts are where cost hides). Unreadable or unpriced data is listed as warnings, never as an error. Compare two periods with `--since` and `--until`.
- `skill-tokens.mjs [--json]`: skill sizes per phase and per skill.
- `review-pr.ts <pr>`: the local pull request reviewer, below.

## Reviewing pull requests

`npm run review -- <pr> [--dry-run] [--force]` reviews a PR with pi and posts one GitHub review: inline comments, a summary, and a confidence score from 1 (must not merge) to 5 (safe to merge). Run it from a checkout with a git remote for the PR's repository.

- The reviewer reads the PR head in a throwaway worktree, read-only, with an empty home and no secrets in its environment.
- Its context is `README.md`, `docs/*.md`, any `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`, the PR text, the linked issue, earlier review threads and the diff.
- Follow-up rounds judge only what changed since the last reviewed commit. A rebase onto a newer base or a rewritten history makes the round a full review, and the summary says so.
- A head that already has a review is skipped. A fourth round needs `--force`, unless the last review had confidence 4 or more.
- Markdown-only PRs are skipped by design, since there is no code to review, unless an earlier review is waiting on code changed since.
- `--dry-run` prints the review instead of posting it, and ignores both gates.

It needs pi signed in to the reviewer's provider. Defaults: provider `openai`, model `gpt-6.1-terra`, thinking `xhigh`. Override them with `REVIEW_PROVIDER`, `REVIEW_MODEL` and `REVIEW_THINKING`. A run is killed after `REVIEW_TIMEOUT_MS` (10 minutes) or `REVIEW_IDLE_MS` without output (2 minutes).

It keeps its own pi profile in `~/.pi/reviewer-pi-improved` (`REVIEW_PI_DIR`), rebuilt from `scripts/review/pi-settings.json`. `auth.json` (and `models-store.json` when present) is symlinked from the main pi dir: `PI_MAIN_DIR`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. A context over 1,000,000 characters stops the run before the model is called. The prompt and settings are read from the PR's base branch, so a PR cannot change the reviewer that judges it.
