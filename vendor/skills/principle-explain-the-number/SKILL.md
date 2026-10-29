---
name: principle-explain-the-number
description: "Apply before you measure, and before you trust, report or act on a number you measured (a speedup, regression, throughput, latency or eval result): find what limits it and rule out that it measured something other than the work."
---

# Explain the number

- **Write the decision before you run.** Name the result that would change a decision, and the noise floor. Stop when the run-to-run spread is larger than the effect.
- **Ask "why not double?"** Name the resource or code path that bounds the result (a core, a lock, the disk, the network, the load generator), from a profile or counters taken during a run, then map it to source. A guess from reading the code is not a limiter.
- **List what else the number could be measuring, and rule out each with evidence:** errors, skipped or cached work, code that never ran, an untuned side, noise, a piece too small to matter end to end.
- **Keep the evidence with the number:** run count, spread and limiter.

For a performance number run the full procedure in the `benchmark-checklist` skill. For an eval result ask the same of the trials: did every run do the task, and does the gap hold across trials.
