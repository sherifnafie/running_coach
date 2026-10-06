# ADR 0001: Provider adapters on official SDKs, own agent loop

- Status: accepted (2026-10-06)
- Context: SPEC §5.8 Spike S1 compared building on the Vercel AI SDK vs pi-ai. Both abstract providers, but the runtime needs provider-specific features that these layers expose late or not at all: Anthropic mid-conversation system messages, thinking-block replay bound to model+conversation, server-side refusal fallbacks, `thinking.display: "updates"` progress notes, eager tool-input streaming; OpenAI Responses encrypted reasoning items; DeepSeek `reasoning_content` echo rules.
- Decision: `@opencoach/engine` implements `ModelProvider` adapters directly on the official SDKs (`@anthropic-ai/sdk`, `openai`) plus an OpenAI-compatible Chat Completions adapter (DeepSeek, Ollama, vLLM, OpenRouter) and a scripted provider for tests, evals and demo mode. The agent loop itself is ours (~300 lines).
- Consequences: more adapter code to maintain (one file per provider), in exchange for full control of caching, replay and streaming. P10 is preserved: everything provider-specific stays behind `ModelProvider` and capability flags.
