---
name: principles-implement
description: Working principles while implementing: prove it works, smallest change, fix root causes, delete before adding.
---

# Implement principles

- Prove it works against the real artifact (run the code, the build, the UI) before declaring done.
- Make the smallest change that solves the problem. Prefer deleting code.
- Fix root causes, not symptoms.
- Remove dead code before adding new code.
- After a rename, grep for the old name and fix what is left.
