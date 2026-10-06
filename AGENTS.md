# Instructions for coding agents working on this repository

This file is for the agents and engineers **building** the harness. It is unrelated to the coach's own `AGENTS.md` inside an athlete workspace (`seed/running/AGENTS.md`, Appendix D).

## Before you change anything
1. Read `SPEC.md` §0–§2 (principles) and the section that covers your task. Load an appendix only when the spec points you to it.
2. Requirement IDs (`[RT-3]`, `[UI-1]`, …) are the unit of traceability. Cite them in commits, PRs and tests.
3. If your change conflicts with the spec, update the spec in the same PR (or open a question) instead of silently diverging. Record significant decisions as ADRs in `docs/adr/`.

## Non-negotiables (from SPEC §2)
- **No coaching logic in harness code.** If a smarter model would make your code unnecessary, it belongs in the seed workspace, a skill, or the constitution (the deletion test, SPEC §1.3).
- **Guarantees live in code:** quiet hours, budgets, raw immutability, sandbox isolation, view isolation, export and delete, the age gate.
- **No secrets in the sandbox. No unauthenticated gateway routes. WebSocket Origin checks are always on.**
- **All time goes through `Clock`.** Never call `Date.now()` directly outside the clock adapter.
- **Provider features stay behind interfaces** (`ModelProvider`, `SandboxProvider`, `VoiceProvider`, …), each with contract tests.
- **Changes to `seed/`, the constitution, skills, the runtime or the engine must pass the eval gates** (Appendix E §E.7).

## Conventions
- TypeScript (strict). Protocol schemas are defined once in Zod (`packages/protocol`); generate types and JSON Schema from them.
- Prefer small, composable modules. Keep the agent loop thin and readable.
- Tests: unit tests plus cassette-based runtime tests (no live model calls in unit tests); eval scenarios for behavior.
