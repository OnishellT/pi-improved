---
name: bend-laws
description: This project keeps laws in LAWS.bend. Read before changing logic a law covers, or when a rule that must never break deserves a proof (pricing, permissions, state machines, limits).
---

# Bend laws

`LAWS.bend` is the user's spec: laws they wrote, `law name: for x: T {a == b : T}`. Bend proves Bend code only, so for any other language a small Bend MODEL of the pure logic stands in, and the project's own tests compare the real code with it.

## Rules

- NEVER edit `LAWS.bend`, and never weaken a law, a model or a test to get a green check. If a law looks wrong, stop and ask the user.
- `PROOF.bend` imports LAWS and holds one `def Laws.<name>` per law, by match/induction. `@unsafe` and `def f?` switch off the termination check, so the proof fails: do not use them.
- Gate: `BEND_NO_TELEMETRY=1 bend --check-only PROOF.bend`. Success prints `ALL PROOFS CHECK` (exit 0); failure prints `SOME PROOFS FAIL` (exit 1) and the unmet goal.
- Syntax: read the "Recursion and Termination", "Quantities" and "Laws and Proofs" sections of `bend guide` before writing Bend. `bend base <Name>` prints a library definition; `?name` in a proof prints the goal there.
- A law is an equality, `{Model.f(x) == y : T}`; a yes/no fact is `{... == True{} : Bool}`. `bend --check-only LAWS.bend` alone fails with "TODO found" while the laws are open; any other error means the file is broken.

## Workflow

1. Worth a law only when the rule is pure, small and costly to break. Not for I/O, regex/JSON/HTTP (Bend has none; strings are lists), or floats.
2. Model: write the function in Bend (`Risk.bend` or similar), as simple as the rule, with `main` reading `IO.args` and printing the answer.
3. Prove every law about the model in `PROOF.bend` until the gate passes.
4. Bridge, when the real code is not Bend: add a test in the project's own test suite that runs many inputs (a table, or a property test) through both the real function and the model, and asserts equal results. Call the model with `bend Model.bend <args>` (about 0.07 s), or build it once: `bend Model.bend -o model` (native) or `-o model.mjs`. Keep it in the existing test command, so verify runs it.
5. A model and the code can drift apart only if the bridge test misses an input: cover the edges the laws talk about.
6. A project written in Bend proves its own code directly; no model or bridge.

A failing bridge test means the code or the model is wrong; decide which from the law, never from which is easier to change.
