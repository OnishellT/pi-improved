---
name: contract-first
description: "Pin the contract before editing: names, files, signatures, argument and return shapes, invalid-input behavior. Use when a change adds or alters an interface, and again before done."
---

# Contract first

Hidden tests fail on wrong names, argument shapes and unchecked input far more than on logic. Decide them first.

## 1. Before editing

Fix every name, signature and return shape in `task_plan`'s `interface` field, spelled letter for letter as the ticket does; with no ticket detail, copy the sibling files' conventions and record each guess as an assumption in `notes`.

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

Per case: reject (the error the siblings use), normalize (say how) or accept.

## 3. Implement

One test per decided behavior, invalid-input cases included, using the contract's exact names. If the contract changes, edit `contract.json` and say why in your final message.

## 4. Before calling it done

```
node {{package}}/scripts/contract-check.mjs
```

It prints `CONTRACT OK` or `CONTRACT NOT MET` with the missing file or name (exit 0 or 1). It matches names as text only, so also confirm every checklist case has a passing test. Do not report the work as finished while it fails.
