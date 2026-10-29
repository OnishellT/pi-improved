---
name: principles-diagnose
description: Working principles while diagnosing bugs: reproduce first, find the root cause, no guards that hide crashes.
---

# Diagnose principles

- Reproduce the failure first. No fix without a repro.
- Ask why until you reach the root cause.
- A guard is a fix only if the guarded state is legitimate.
- Grep for the same fault elsewhere.
- After a restart, suspect persisted state.
- Confirm the repro passes after the fix.
