---
name: reflect
description: Spawn three parallel review subagents over the transcript, surface learnings, and route each to a concrete edit on an existing skill.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

The parent finds its own transcript file before fanning out. Pi keeps sessions in `~/.pi/agent/sessions/--<cwd with / as ->--/<timestamp>_<id>.jsonl`, one folder per working directory (`PI_CODING_AGENT_DIR` or `--session-dir` may move it). Look only in the current workspace's folder; do not glob across the others, which holds unrelated private chats.

```bash
ls -t ~/.pi/agent/sessions/--<cwd>--/*.jsonl | head -5
```

The newest file is normally the active session. Confirm it: the first user message in it should match the conversation's opening prompt. If no file resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

Spawn three reviewers in parallel, one per lens below; give them the default tools (not `--tools`), so they keep any extension tools such as MCPs for context lookups (tickets, chat threads, observability traces referenced in the transcript). Subagents run through the pi `subagent` CLI: `subagent spawn --name <role> --prompt "<prompt>" [--file <brief.md>] [--tools read,grep,find,ls]` prints a handle; spawn every parallel one first, then `subagent wait <handle>` for each (its output is the result) and `subagent stop <handle>`. Do not pass `--provider` or `--model`. If no subagent is available, do each pass yourself in sequence.

| Lens | Prompt template |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the subagent output.

### 3. Synthesize

One subagent with the default tools. Its quality check includes spot-verifying citations, which can require MCP access. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): write the skill edit yourself and test it on a real case, iterating until it triggers and reads right.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite its description yourself and re-test that it triggers.
- `new skill via create-skill: <kebab-name>`: create it yourself, following the shape of the existing skills in this repo.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
