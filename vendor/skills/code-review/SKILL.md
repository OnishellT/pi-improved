---
name: code-review
description: Review a diff on two axes, repo standards and spec compliance, and report findings ranked by severity.
---

# Code review

Review the diff against a fixed point (commit, branch, merge-base). In a review run the diff is supplied in the brief: you cannot run git, so do not try to resolve refs or list commits. Use your read tools on the files it names.

## Two axes

Keep the axes separate so one cannot mask the other.

- **Standards:** does the change follow this repo's documented standards (CONTRIBUTING, coding-standards docs, AGENTS.md)? Cite the rule for each breach. The repo overrides general taste. Skip what tooling already enforces.
- **Spec:** does the change do what the originating issue or spec asked? Find the spec in the brief (intent, plan, ADRs), a path the user gave, or a doc matching the branch. Report missing or partial requirements, unrequested scope, and implementations that look wrong. Quote the spec line. If there is no spec, say so and skip this axis.

## Smell baseline

Even with no documented standards, flag as judgement calls (never hard violations): mysterious names, duplicated code, feature envy, data clumps, primitive obsession, repeated switches, shotgun surgery, speculative generality, message chains, middle men.

## Report

- List findings per axis, ranked: hard violations and spec failures first, judgement calls last.
- Quote the hunk and name the fix for each.
- End with the count per axis and the worst finding in each. Do not rank across axes.
