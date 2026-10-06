# OpenCoach (working title)

**An open-source, AI-native running coach.** An agentic LLM *is* the coach. The app is a thin harness that gives it a persistent workspace, a clock, senses (chat, screenshots, files, voice), hands (code, files, web, messaging, helpers) and a face (app screens it writes itself).

The TypeScript monorepo includes a self-hosted server, React PWA, isolated coach workspaces, model adapters, voice services and an offline evaluation harness.

```sh
pnpm install --frozen-lockfile
pnpm build
OPENCOACH_DEMO=1 pnpm start
```

Open **http://localhost:8080** and use the setup code printed at startup. The demo requires no API keys. For a real coach, remove `OPENCOACH_DEMO` and set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. Linux user namespaces or a configured Docker sandbox are required. Chromium enables coach-authored view previews.

See [self-hosting](docs/self-hosting.md) for configuration, separate view origins, mobile access, Docker, export and import. Development checks: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm eval:selftest`, and `pnpm test:e2e`.

## Documents

| Document | What it covers |
|---|---|
| [`SPEC.md`](SPEC.md) | **Start here.** Vision, principles, architecture, runtime, workspace, tools, UI system, data ingestion, voice, safety, privacy, cost, evals, roadmap, risks, open questions |
| [`docs/appendix-a-landscape.md`](docs/appendix-a-landscape.md) | Research as of Oct 2026: models, agent harnesses, voice APIs, generative-UI protocols, sandboxes, health-data access, competitors (with sources) |
| [`docs/appendix-b-constitution.md`](docs/appendix-b-constitution.md) | Draft of the coach's non-editable system prompt |
| [`docs/appendix-c-contracts.md`](docs/appendix-c-contracts.md) | Event types, tool contracts, micro-UI schema, view manifest and bridge API, gateway API, adapter interfaces |
| [`docs/appendix-d-seed-workspace.md`](docs/appendix-d-seed-workspace.md) | The day-zero workspace: file tree, starter files, DB schema, helper profiles, skills, seed views, sandbox image |
| [`docs/appendix-e-evals.md`](docs/appendix-e-evals.md) | Athlete simulator, time machine, eval suites and gates, model conformance |

## The idea in five lines

1. **Mechanism in the harness, policy in the model.** We never hard-code coaching logic.
2. **The workspace is the coach.** Memory, data model, plans and even the app's views live in a versioned, portable workspace the AI owns. Swap the model and the coach continues.
3. **Proactive like a real coach.** It schedules its own check-ins, within quiet hours and message budgets the athlete controls.
4. **Natural input.** Screenshots, exports, voice notes, calls and conversation. No integrations required.
5. **Behavior is specified by evals.** A simulated-athlete time machine defines what "good coaching" means.
