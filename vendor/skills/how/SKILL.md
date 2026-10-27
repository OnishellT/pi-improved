---
name: how
description: Explain how a subsystem works: architecture, runtime flow, placement and ownership questions, walkthroughs before changing code.
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Subagents run through the pi `subagent` CLI: `subagent spawn --name <role> --prompt "<prompt>" [--file <brief.md>] [--tools read,grep,find,ls]` prints a handle; spawn every parallel one first, then `subagent wait <handle>` for each (its output is the result) and `subagent stop <handle>`. Do not pass `--provider` or `--model`. If no subagent is available, do each pass yourself in sequence.

## Step 1. Assess Complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. One explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): spawn parallel explorers first, then hand off to the explainer. Go to Step 2a.

When in doubt, take the simple path.

## Step 2a. Explore (complex questions only)

Decompose the question into 2 to 4 exploration angles, each a distinct slice of the subsystem. Spawn all explorers in parallel, read-only (`--tools read,grep,find,ls`).

Each explorer gets the prompt in `references/explorer-prompt.md` with its angle filled in. Then go to Step 3.

## Step 2b. Direct Explain (simple questions)

Spawn one read-only subagent that explores and explains in one pass.

Build its prompt from `references/explainer-prompt.md` without the explorer-findings section. Go to Step 4.

## Step 3. Synthesize (complex questions only)

Once all explorers have returned, spawn one read-only subagent to synthesize their findings into one explanation.

Build its prompt from `references/explainer-prompt.md` with every explorer's findings filled in.

## Step 4. Present

Present the explainer's output to the user. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output Format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
