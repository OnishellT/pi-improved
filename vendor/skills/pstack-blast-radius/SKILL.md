---
name: pstack-blast-radius
description: "Find what a change could break somewhere else before it ships, beyond the diff, and prove the one fact it's safe because of by running real code instead of writing it up. Use for 'blast radius of X', 'what could this break', or reviewing a small diff you don't trust."
---

# Blast radius

Find what a change breaks somewhere else. Listing callers is not the job (grep does that); the job is the breakage grep won't show. A convincing writeup proves nothing, so prove the one fact the safety rests on by running code.

## Steps

1. Read the change: the diff, the symbols it adds, changes and deletes, and what now behaves differently, including what the diff doesn't spell out. Use repository evidence only; no remote fetch without a grant.
2. Find the one fact it is safe because of (e.g. "this call only drops already-dead cache entries"). If it holds, most risky cases clear at once. Spend your time here, not on a list of maybes.
3. Look where grep stops: the source and pinned version of libraries you call, local patches, timing (microtasks, unmount, teardown), and anything a symbol search misses (API JSON, DB columns, wire formats, another language reading the same bytes, feature flags, code three hops downstream).
4. Rate each risk with a real chance and a real cost, citing a real `file:line` (an empty search is still an answer; never invent a caller or API). Keep confirmed risks, cleared risks and unknowns separate.
5. Prove the one fact: write a script or test that imports the real code and fails loud if you are wrong, run it, and paste what happened. Say how far each fact got: 1 you said so, 2 you pointed at the line, 3 you showed the bad case cannot happen, 4 you ran it, 5 you reproduced it in the running app.
6. For a big change, add bounded read-only passes and merge evidenced findings; use approved delegation for independent review, otherwise report it as self-review.

## Hand back

- **What it does**, including the non-obvious part.
- **The one safety fact**, the step it reached and the proof, or "unproven".
- **Risks**: how it breaks, `file:line`, likelihood and cost, how to check.
- **Cleared**: what you checked and why it is fine.
- **Before you merge**: the cheapest test or repro that catches the real bug, including your script.

Be concise and concrete; strip anything private before it goes public.

**Reply:** the writeup above, with the one safety fact either proven or marked unproven.
