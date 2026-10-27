# Vendored skills

- mattpocock/skills @ 5beb35b040e3 (MIT): grilling, domain-modeling, tdd, diagnosing-bugs, retro
- pstack (MIT, Lauren Tan): technical-writing, create-verification-skill, maintain-verification-skill, blast-radius
- contract-first (original, not upstream; ported from cc-improved D-015): pin names, signatures and invalid-input behavior before editing, checked by `scripts/contract-check.mjs`. The `{{package}}` placeholder becomes the package path on injection.

The workflow injects these per phase (see src/skills.ts). Injection drops each skill's `## Agent integration boundary` section and only reads `.md` files next to `SKILL.md`; `references/` is never injected. Measure sizes with `node scripts/skill-tokens.mjs`.

## Condensed derivatives vs verbatim

Condensed derivatives (rewritten for fewer tokens, same meaning; the MIT licenses in `LICENSE-*` still apply):

- `tdd` (mattpocock/skills): three rules plus one-line anti-patterns; `tests.md` and `mocking.md` moved to `tdd/references/`.
- `diagnosing-bugs` (mattpocock/skills): non-deterministic and no-loop cases moved to `diagnosing-bugs/references/hard-cases.md`.
- `pstack-blast-radius` (pstack): steps only.

Verbatim from upstream (update by re-copying): `grilling`, `domain-modeling`, `retro`, `pstack-technical-writing`, `pstack-create-verification-skill`, `pstack-maintain-verification-skill`.

When updating a condensed skill from upstream, re-apply the condensation instead of overwriting.
