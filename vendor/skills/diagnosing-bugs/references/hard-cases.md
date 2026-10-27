# Hard cases for Phase 1

## Non-deterministic bugs

The goal is not a clean repro but a higher reproduction rate. Loop the trigger 100x, parallelise, add stress, narrow timing windows, inject sleeps. A 50% flake is debuggable; 1% is not, so keep raising the rate until it is.

## When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a redacted captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do not proceed to hypothesise without a loop.
