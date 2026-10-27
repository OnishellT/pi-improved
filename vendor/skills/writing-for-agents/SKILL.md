---
name: writing-for-agents
description: How to write AGENTS.md, skills and docs that an agent reads: pointers, hierarchy, completion criteria, pruning.
---

# Writing for agents

Applies to any document an agent consumes. The goal is the same process every run.

## Pointers

A line that names out-of-context material is a context pointer. Its wording decides whether the agent reaches the material.
- Front-load the trigger word. One trigger per distinct branch. Cut what the body already says.
- Weak pointer to a must-have doc is a bug: sharpen the wording before inlining.

## Two loads

- Context load: always-loaded lines (AGENTS.md, skill descriptions) cost tokens every turn. Prune hardest there.
- Cognitive load: the human must remember which docs exist. Spend it only where human judgement matters.

## Hierarchy

1. In-file steps: what to do, in order.
2. In-file reference: consulted on demand.
3. Disclosed reference: a separate file behind a pointer, loaded only when needed.

Inline what every branch needs; push behind a pointer what only some branches reach. Keep a concept's definition, rules and caveats under one heading. A document that is too long thins attention even if every line is live: split by branch or sequence.

## Steps

End every step with a checkable, exhaustive completion criterion ("every modified model accounted for"). A vague bound invites finishing early. If the later steps tempt the agent to rush, sharpen the bound first; split the sequence across a real context boundary only if that fails.

## Wording

- Use one pretrained leading word ("tight", "red", "tracer bullet") in place of a spelled-out triad. Reach for an existing word before coining one.
- State the target behaviour, not the ban. Prohibitions make the banned thing more available; use them only as hard guardrails, paired with the positive.

## Pruning

- One source of truth per meaning.
- Do not restate what the environment shows (scripts, config, directory layout, --help). Write only what cannot be found by looking: unwritten conventions, reasons, gotchas.
- Delete stale lines and no-ops, whole sentences at a time. Test: does the line change behaviour from the default?
