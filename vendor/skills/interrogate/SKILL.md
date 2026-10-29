---
name: interrogate
description: "Adversarial review of a change or design: adversaries try to break it, and only findings reproduced with a command and its output survive. Use for \"interrogate\", \"challenge this\", \"stress test this code\", \"tear this apart\"."
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a command and its output prove it. Report findings; do not apply fixes.

## Frame

The scope is what the user names, else the branch diff from its merge base through the working tree. Restate the intent in one paragraph from the user's message, the commits and the PR description. Ask the user when the intent is unclear.

## Fan out

Spawn two adversaries through the pi `subagent` CLI: `subagent spawn --name <role> --cwd <copy> --prompt "<prompt>" --file <brief.md>` prints a handle; spawn both first, then `subagent wait <handle>` for each (its output is the result) and `subagent stop <handle>`. Do not pass `--provider` or `--model`. Give them the default tools, since they must run things. If no subagent is available, do both passes yourself in sequence.

Before spawning, make each adversary its own copy (`git worktree add <copy> HEAD`, then the scope's uncommitted changes applied) and start it there with `--cwd <copy>`, so repros never touch the real tree. Remove the copies when done. The brief is the scope, the intent and:

> Break this change. Prove each finding against the real code: a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, probe the current tree. Report each finding as a title, the exact command, the output it printed and the output the intent requires. Leave out anything you did not run: style, naming, structure, risks that need a future change to matter. No findings is a valid result.

## Verify

Rerun each finding's command yourself, in an adversary's copy. Keep it when the output shows the failure and the failure breaks the intent. Drop the rest, and merge findings that share a root cause. Adversaries find different failures, so keep every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each, the command, its output, how it breaks the intent and who found it. "No verified findings" when none survive.
- **Dropped**: per adversary, how many findings were dropped and why (not reproduced, not breaking the intent).
