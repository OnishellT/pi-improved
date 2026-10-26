---
name: contract-first
description: "Pin the contract before editing code: exact names, files, signatures, argument and return shapes, and what happens on invalid input. Use at the start of any feature or fix that adds or changes an interface, and again before calling the work done."
---

# Contract first

Hidden tests fail on wrong names, wrong argument shapes and unchecked input far more often than on logic. Decide them first, then write code.

## 1. Before editing: write the contract

For each thing you add or change, fix:

- **File and exact name** of every function, class, command or endpoint. Use the ticket's spelling letter for letter.
- **Signature**: parameters in order, positional or one options object, defaults, return value (type, shape, sync or async).
- **Behavior on invalid input** (section 2).

If the ticket gives no name or shape, copy the conventions of the sibling files (same folder, same layer, their tests): naming case, export style, error type, how they report failure. Record each guess as an assumption in `notes`; never present a guess as a requirement.

Save it as `.pi/contract.json` (plain JSON, any language):

```json
{"files": ["src/slug.js", "src/slug.test.js"], "names": ["slugify"], "notes": "assumed: named export like title-case.js; throws TypeError on non-string"}
```

`files` are the paths you create or change, `names` the identifiers that must exist. Keep it small: only what a caller or test depends on.

## 2. Input validation checklist

For every public entry point, decide each case, implement it and test it. A skipped case is decided by accident.

- **Wrong type**: string where a number is expected, object where a list is expected.
- **null / undefined / None / nil**: missing argument, explicit null, null inside a collection.
- **Empty**: empty string, list or map; whitespace only.
- **Out of range**: zero, negative, above a maximum, NaN or infinity, off-by-one at both ends, very large input.
- **Duplicates**: repeated items or keys; the same call twice (idempotence).

Per case: reject (the error the siblings use), normalize (say how) or accept. Follow the siblings unless the ticket says otherwise; note non-obvious choices.

## 3. Implement

Write one test per decided behavior, invalid-input cases included, using exactly the contract's names and shapes. If the contract must change, edit `contract.json` and say why in your final message.

## 4. Before calling it done

```
node {{package}}/scripts/contract-check.mjs
```

It prints `CONTRACT OK` or `CONTRACT NOT MET` with the missing file or name (exit 0 or 1). It matches names as text only, so also confirm every checklist case has a passing test. Do not report the work as finished while it fails.
