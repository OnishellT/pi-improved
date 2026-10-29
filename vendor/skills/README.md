# Vendored skills

These skills are rewrites of MIT-licensed skills; the upstream licenses stay here as `LICENSE-mattpocock` (mattpocock/skills) and `LICENSE-pstack` (pstack, Lauren Tan). To take an upstream change, re-apply it by hand instead of copying the upstream file over: the copies here are condensed and their subagent steps use pi's `subagent` CLI.

The workflow injects these per phase (see src/skills.ts). Injection drops each skill's `## Agent integration boundary` section and only reads `.md` files next to `SKILL.md`; `references/` is never injected. In `contract-first` and `pstack-create-verification-skill`, `{{package}}` becomes the package path on injection; `scripts/contract-check.mjs` checks the contract. Measure sizes with `node scripts/skill-tokens.mjs`.
