---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

Tests verify behavior through public interfaces, not implementation details. A good test reads like a specification ("user can checkout with valid cart") and survives refactors. Match test names to the project's `GLOSSARY.md` vocabulary if it exists.

## Rules

1. **Test only at pre-agreed seams.** A seam is a public boundary where behavior is observable; the plan's `seams` field lists them. Write no test at a seam the plan does not name.
2. **Red before green.** Write the failing test first, then only enough code to pass it. No speculative features.
3. **One vertical slice at a time.** One seam, one test, one minimal implementation per cycle; never all tests first, then all code.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or checks through a side channel (querying the database instead of the interface). The tell: the test breaks on a refactor that changes no behavior.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`). Take expected values from a literal, a worked example or the spec.
- **Horizontal slicing**: bulk tests verify imagined behavior and go insensitive to real changes; each test is a tracer bullet that responds to what the last cycle taught.

Examples and mocking guidance: `references/tests.md`, `references/mocking.md` (not injected; read only if needed).
