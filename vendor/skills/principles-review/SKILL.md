---
name: principles-review
description: Reviewer checklist: errors, tests, purpose, boundaries, abstraction, public behaviour, comments, evidence.
---

# Review checklist

Block only on real defects. The brief's warnings are fuzzy scans: judge each.

- Swallowed errors (empty, log-only, catch-all)?
- Tests weakened, skipped or deleted? A bug fix without a test that fails without it?
- Refactor, formatting or moved code mixed with logic?
- Input checked at the edge, internal data not re-checked?
- A layer with one use? A clone edited in one copy?
- Public behaviour or API changed without docs or a deprecation path?
- Comments say why; no commented-out or dead code.
- Do the brief's verify commands cover the claim?
