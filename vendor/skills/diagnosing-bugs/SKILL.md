---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow.
---

# Diagnosing Bugs

Skip a phase only with an explicit reason. Redact every secret in shown commands, output and artifacts (`<REDACTED>`); keep credentials in env vars and quote only the lines that carry the signal.

## Phase 1: Build a feedback loop

A tight pass/fail signal that goes red on this bug is the whole skill; without one, reading code will not save you. Spend disproportionate effort here.

Build one, in roughly this order:

1. Failing test at whatever seam reaches the bug.
2. Curl or CLI script against a running server, diffing output against a known-good snapshot.
3. Headless browser script asserting on DOM, console or network.
4. Replay of a captured trace, payload or log through the code path.
5. Throwaway harness: a minimal subset of the system calling the buggy path once.
6. Property or fuzz loop for "sometimes wrong output".
7. Bisection or differential loop between two known states (commit, version, config); automate it for `git bisect run`.
8. Last resort: a human clicks, driven by a minimal loop script you write yourself: it prints each step to do, waits for the person, and records what they report.

Then tighten it: faster (narrow scope, cache setup), sharper (assert the exact symptom, not "didn't crash"), more deterministic (pin time, seed RNG, freeze network).

Phase 1 is done when one command that you have already run (show invocation and output) is red-capable (asserts the user's exact symptom), deterministic, seconds-fast and runnable unattended. Reading code to build a theory before that command exists is the failure this skill prevents. Non-deterministic bugs and no-loop cases: `references/hard-cases.md`.

## Phase 2: Reproduce and minimise

Run the loop and confirm it shows the failure the user described (wrong bug, wrong fix), reproducibly, with the exact symptom captured. Then cut inputs, callers, config, data and steps one at a time, re-running after each cut, until every remaining element is load-bearing (removing any makes it go green). Do not continue until reproduced and minimised.

## Phase 3: Hypothesise

Write 3-5 ranked, falsifiable hypotheses before testing any: "If X is the cause, then changing Y makes the bug disappear." No stated prediction means discard or sharpen it. Show the list to the user before testing; do not block if they are away.

## Phase 4: Instrument

Each probe maps to one hypothesis; change one variable at a time. Prefer a debugger over targeted logs, never "log everything and grep". Tag every debug log `[DEBUG-a4f2]` so cleanup is one grep. For performance, measure a baseline first, then bisect.

## Phase 5: Fix and regression test

Write the regression test before the fix, but only at a seam that exercises the real bug pattern as it occurs at the call site (a too-shallow test gives false confidence). With no such seam, that is the finding: note that the architecture prevents locking the bug down.

1. Turn the minimised repro into a failing test; watch it fail (if you forced red by mutating code or a fixture, `diff` against a pristine copy to prove it landed).
2. Apply the fix; watch it pass.
3. Re-run the Phase 1 loop on the original, un-minimised scenario.

Before done: remove all `[DEBUG-...]` lines and throwaway prototypes, and state the correct hypothesis in the commit message.
