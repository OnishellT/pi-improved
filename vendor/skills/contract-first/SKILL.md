---
name: contract-first
description: "Pin the contract before editing: names, files, signatures, argument and return shapes, invalid-input behavior. Use when a change adds or alters an interface, and again before done."
---

# Contract first

Hidden tests fail on wrong names, argument shapes and unchecked input far more than on logic. Decide them first.

## 1. Before editing

Write the caller's usage first: for each `interface` entry, the call a test would make, in the ticket's words, goes in its `usage` line (code checks the names it calls exist). Then fix every name, signature and return shape in `task_plan`'s `interface` field, spelled letter for letter as the ticket does. With no ticket detail, copy the sibling files' conventions; a name nobody gave gets `source: 'user'`, so the user is asked. Keep it small: only what a caller or test depends on.

## 2. Input validation checklist

For every public entry point, decide each case, implement it and test it. A skipped case is decided by accident.

- **Wrong type**: string where a number is expected, object where a list is expected.
- **null / undefined / None / nil**: missing argument, explicit null, null inside a collection.
- **Empty**: empty string, list or map; whitespace only.
- **Out of range**: zero, negative, above a maximum, NaN or infinity, off-by-one at both ends, very large input.
- **Duplicates**: repeated items or keys; the same call twice (idempotence).

Per case: reject (the error the siblings use), normalize (say how) or accept.

## 3. Implement

One test per decided behavior, invalid-input cases included, using the interface's exact names. If a name must change, say why in your final message.

## 4. Before calling it done

The gate checks that every interface name exists in its files, as text only, so also confirm every checklist case has a passing test.
