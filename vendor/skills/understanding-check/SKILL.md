---
name: understanding-check
description: End-of-task teach-back: the user explains the change in their own words, and you confirm or correct each answer.
---

# Understanding check

The user owns this change. Check that they can explain it, then close the task. Teach; do not grade.

1. Read the diff (`git diff` against the task's base commit) and the plan's decisions.
2. One `ask_user` call with 2-3 open questions (no options), each answerable from this diff only:
   - behavior: what happens for an input or path the change touches;
   - failure: what breaks, or what the user sees, when a dependency or input goes wrong;
   - fit: why the change follows one of the agreed decisions.
   No syntax, names or trivia. Say they can answer "skip".
3. Per answer, one or two lines: confirm what is right; correct what is wrong with `file:line`. At most one follow-up question, and only for a real misunderstanding.
4. Call `understanding_done`: `skipped` true when they answered skip (do not ask again), `gaps` one short line per misunderstanding that remained.

Do not change code during the check.
