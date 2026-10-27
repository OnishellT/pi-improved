---
name: pr
description: How to write a PR body: summary visual, before/after evidence, merge danger.
---

# PR body

No preamble, brief prose, the repo's domain language. Three sections:

- **Summary:** the smallest view that makes the point: pseudocode, call tree, component or file tree, or a diff sketch.
- **Evidence:** before and after. Prefer screenshots for visual changes, otherwise the exact test or output that failed and now passes.
- **Merge danger:** is it a one-way or two-way door (can it be rolled back?), and the blast radius in one word, plus any ramifications.
