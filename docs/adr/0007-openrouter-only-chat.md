# ADR 0007: Chat models through OpenRouter; per-athlete keys and billing modes

- Status: accepted (2026-10-07). Supersedes the adapter list in ADR 0001; ADR 0001's own-loop decision stands.
- Context: the owner runs one instance for a few family members. Separate Anthropic, OpenAI and DeepSeek accounts meant three bills, three key types and price tables that had to be maintained by hand (unknown models counted as $0 against budgets). The family needs simple payment, a model choice, and hard spending limits. Some members may later want to pay for their own usage.
- Decision:
  - **Chat models go through OpenRouter** (`createOpenRouterProvider`, built on the OpenAI-compatible adapter). The Anthropic and OpenAI chat adapters are removed. OpenAI stays only for voice (speech, realtime calls). The compatible adapter stays for local or other endpoints (Ollama, vLLM, OpenCode GO), which keeps P10.
  - OpenRouter specifics live in the adapter, not the runtime:
    - per-model capabilities come from a vetted catalog;
    - the unified `reasoning.effort` parameter;
    - `reasoning_details` streamed as fragments, merged per index and replayed unchanged within tool loops to the model that produced them;
    - provider routing defaults to `data_collection: deny` and `require_parameters: true`, with hosts pinned per model so prompt caching hits (a host switch is a cache miss; measured: about 16x cheaper on a cache hit);
    - the charged `usage.cost` is recorded as `Usage.costUsd` and preferred over price tables.
  - **Model catalog** (`packages/engine/src/openrouter-catalog.ts`, overridable with `providers.openrouter.models`). It was picked from the Artificial Analysis leaderboard (intelligence, agentic tool use, long-context reasoning, AA-Omniscience hallucination rate, latency, cost per task) and the OpenRouter model API. Each entry called tools and read a workout screenshot correctly through OpenRouter with privacy routing.
    - The default is DeepSeek V4.1 Flash: fastest, cheapest and verified in this harness. Its weakness is a high hallucination rate (AA non-hallucination 4%).
    - Alternatives: GLM-5.3 Flash (careful), MiMo V2.6 Pro (strongest reasoning on a budget), Gemini 3.8 Flash (best vision), GPT-6.1 Sol (premium).
    - Claude was left out at first because Anthropic models only cache with `cache_control`. See the 2026-10-07 update below.
    - Qwen3.8 Flash was rate-limited upstream during selection.
  - **Per-athlete keys and billing modes** ([SEC-1], [COST-1]). Keys are encrypted at rest (AES-256-GCM bound to athlete and provider; key file `<dataDir>/secrets/credentials.key`), held decrypted only in the gateway process, shown as a masked hint, never placed in sandboxes or exports, and deleted with the account. The router resolves a provider bound to the athlete's key when one exists (`route(tier, override, { athleteId })`).
    - *Managed* (default): the deployment's key, or a per-athlete key an administrator assigned, for example one with its own OpenRouter credit limit. Budgets are administrator-only, and the monthly budget is a **hard allowance**: no model call once it is reached.
    - *Bring your own key*: the athlete connects their OpenRouter account (OAuth PKCE) or pastes a key. They set their own soft budgets and model.
  - **Account recovery**: administrators can issue a 30-minute device pairing code for another athlete.
- Consequences:
  - One bill and one key type. Costs are exact rather than estimated.
  - OpenRouter becomes a dependency for chat. The compatible adapter remains the fallback path, and any OpenAI-compatible endpoint can still serve tiers.
  - Provider-native features the removed adapters had (Anthropic mid-conversation system messages, thinking-display progress notes, server-side refusal fallbacks) are not used. [MOD-4] already treats them as optional.
  - Bring-your-own OpenAI keys for voice are not implemented yet. The voice services are created once with the server key; scoping them per athlete is follow-up work.

## Update 2026-10-07: Claude Haiku 5.5 becomes the default

- Catalog entries can set `promptCache` (`5m` or `1h`), which sends OpenRouter's request-level `cache_control`; the breakpoint follows the end of the conversation. Haiku 5.5 uses `1h`, so a prefix stays warm between messages minutes apart.
- Claude Haiku 5.5 (released the same day) is the default, with DeepSeek V4.1 Flash kept in the catalog. Evidence:
  - **Artificial Analysis:** intelligence 38 at high effort and 43 at max, against DeepSeek's 39 at max. It avoided hallucinating 55-60% of the time, against 4% for DeepSeek. Cost per task is $0.08-0.21, against $0.27.
  - **Live probes:** tools, a mid-conversation system message, screenshot reading and cache hits (13,933 of 13,935 prompt tokens) all worked. First answer token arrived in about 4-5 s, against 6.3 s for DeepSeek.
  - **Real eval scenarios:** in the three `disciplines` scenarios it matched DeepSeek on reply and record checks at a similar cost (about $0.008-0.009 per scenario, 99.99% cache hits). It asked instead of guessing. In the hybrid-week scenario DeepSeek wrote a plan that failed the availability check, and it deferred work "for a day".
- The coach tier no longer pins reasoning effort. It follows the trigger class: medium for replies, low for scheduled check-ins, medium for consolidation. Deep work stays at high.
