---
name: principles-diagnose
description: Working principles while diagnosing bugs: reproduce first, ask why to the root cause, no guards that hide crashes.
---

# Diagnose principles

- Reproduce the failure first. No fix without a repro.
- Ask why repeatedly until you reach the root cause, not the first symptom.
- Do not add nil-checks or try/catch guards that silence a crash; fix why the value is wrong.
- Confirm the repro passes after the fix.
