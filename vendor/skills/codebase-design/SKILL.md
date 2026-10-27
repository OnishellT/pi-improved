---
name: codebase-design
description: Shared vocabulary for designing deep modules: module, interface, depth, seam, adapter, leverage, locality.
---

# Codebase design vocabulary

Use these terms exactly; do not substitute "component", "service", "API" or "boundary".

- **Module:** anything with an interface and an implementation, at any scale.
- **Interface:** everything a caller must know: types, invariants, ordering, errors, config.
- **Depth:** behaviour per unit of interface. Deep means much behaviour behind a small interface.
- **Seam:** the place where a module's interface lives and behaviour can change without editing there.
- **Adapter:** a concrete thing that satisfies an interface at a seam.
- **Leverage:** what callers get from depth.
- **Locality:** what maintainers get from depth: change and bugs concentrate in one place.

One adapter is a hypothetical seam; two is a real one. If deleting a module only moves complexity into callers, it earned its keep.
