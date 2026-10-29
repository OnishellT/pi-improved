---
name: principles-implement
description: Working rules while implementing: one purpose, no swallowed errors, tests never weakened, evidence before done.
---

# Implement rules

- One purpose, plan files only, no refactors.
- Match neighbours; validate only at the boundary.
- Never swallow errors (empty, log-only, catch-all).
- Bug fix: add a test that fails without it. Never weaken, skip or delete a test; if one is wrong, say so.
- No abstraction before a second use, no commented-out code.
- No unplanned dependency. Run only the plan's test files; the gate runs the full verify.
