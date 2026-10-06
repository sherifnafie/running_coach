# ADR 0002: Naming conventions across boundaries

- Status: accepted (2026-10-06)
- Decision: model-facing contracts (tool inputs, micro-UI, `view.json`, `app.json`) use snake_case exactly as written in SPEC Appendix C. Everything else (event payloads, HTTP JSON, WebSocket messages, TypeScript) uses camelCase, and SQL columns use snake_case. Appendix C §C.1 and §C.5 examples written in snake_case are therefore normative for field *meaning*, but their JSON spelling is camelCase.
- Rationale: models are trained on both conventions and the spec examples are snake_case. TypeScript and JSON APIs in this codebase are idiomatic camelCase.
