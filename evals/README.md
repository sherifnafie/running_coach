# Coaching evaluations

The simulator (`packages/evals-sim`) runs scenarios against the production runtime [EV-1]. It uses the real SQLite store, seeded workspaces, sandbox tools and scheduler, with a `VirtualClock`. It jumps straight to the next athlete action or runtime wake-up instead of waiting in real time. Only messages delivered through `send_message` count as replies.

```sh
pnpm eval:selftest                                   # offline: reference coach passes, bad coach is rejected
pnpm eval --suite fast --model reference --out work/eval-fast
pnpm eval --scenario evals/suites/acute-chest-pain.yaml --model bad
pnpm eval --suite gates --model anthropic:claude-sonnet-5-5 --judge openai:gpt-6.1-sol --seeds 3 --out evals/runs/gates
pnpm eval --suite conformance --model opencode-go:deepseek-v4.1-flash --out evals/runs/conformance
```

**Conversations** (`pnpm --filter @opencoach/evals-sim eval:chat --coach <openrouter id> [--deep <id>] [--scenario a,b] --out <dir>`): a model-played athlete talks to the production runtime in real multi-turn conversations (the owner's first conversation, a boulderer with a niggle, a buried red flag). It writes `transcript.md` per scenario (messages, turn notes, helper results, cost) for side-by-side reading; nothing is graded. It needs `OPENROUTER_API_KEY` and spends real money (about $0.05–0.20 per scenario on Haiku-class models), so use a key with a spending limit, not the production key.

**Models.**
- `reference` and `bad` are scripted offline controls. They check the harness and the graders, not coaching quality. The reference coach sees only what a real coach would: intake, uploads and conversation.
- Real runs take `provider:model`, where the provider is `openai`, `anthropic`, `deepseek` or `opencode-go`, with that provider's key in the environment.
- A judge is optional and must be named explicitly. Prefer a different model family from the coach.
- Unit tests and the self-test never call a model.

**Suites** (defined in `src/suites.ts`; custom scenarios are YAML, such as those in `evals/suites/`):

| Suite | Contents |
|---|---|
| `fast` | 25 short scenarios covering every gate dimension |
| `gates` | Self-test fixtures plus the red-flag, ED/RED-S, crisis, unsafe-request and injection sets |
| `planning` | Sparse intake, a one-week horizon, and a four-week draft with a separate review |
| `vo2max`, `vo2max-ui` | See [vo2max.md](vo2max.md) |
| `conformance` | Provider probes: tool calls, long context, steering. Writes `compatibility.json`. |
| `all` / `nightly` | The whole focused catalog |
| `cohort` | All 12 personas over 16 weeks |

**Graders.**
- The deterministic graders (`src/graders.ts`) require zero availability violations, quiet-hours violations, fabricated fields and duplicate rows.
- They also check safety language on the first reply, memory of disclosed facts, provenance, schedule persistence, message rates and follow-up ghosting.
- Plan heuristics (load ramps, long-run share, down weeks, taper) are flags for the plan judge, not gates.
- Missing evidence counts as `not_run`, which blocks a gate just like a failure. Every seed is kept, with no retrying until green.
- The judge rubrics (`src/judges.ts`) score 1–5 against evidence and have a separate critical-failure flag. They have not been calibrated with human coaches yet (Appendix E §E.8).

**Simulation and artifacts.**
- The physiology is a seeded, stylized fitness/fatigue and pain model, not a medical model.
- Screenshots and GPX files are synthetic, and their labels contain only the values actually shown.
- Chromium is needed for screenshot and UI scenarios; set `OPENCOACH_CHROMIUM_PATH` or pass `--chromium`.
- Sandbox commands only follow the virtual clock when libfaketime is installed. The runtime itself always does.

**Outputs.** Each run writes `trace.json`; each suite writes `summary.json` and a `viewer.html` for side-by-side comparison. `evals/runs/` and `work/` are gitignored. Costs use provider-reported tokens and the configured prices.
