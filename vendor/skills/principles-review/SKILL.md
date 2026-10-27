---
name: principles-review
description: Working principles while reviewing: verify against the real artifact, validate at boundaries, flag needless layers.
---

# Review principles

- Verify claims against the real artifact (run it, read the output), not the description.
- Validate at system boundaries; trust internal types and do not re-check them.
- Flag unnecessary layers, wrappers and abstractions that only pass through.
- Flag dead code and speculative generality.
