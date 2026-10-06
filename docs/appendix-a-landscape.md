# Appendix A: Landscape research

**As of 2026-10-06.** This field moves weekly. Treat every fact here as "verify before you depend on it". The build team SHOULD re-check model IDs, prices and API shapes at implementation time. Each section ends with **Implications** for this project. Sources are listed per section; a few vendor pages could not be fetched directly from the research environment and were confirmed through secondary coverage, as noted.

---

## A.1 Frontier models for the coach brain

| Family | Models (role) | Context | Price (input / output per MTok) | Notes relevant to us |
|---|---|---|---|---|
| **Anthropic Claude** | Fable 5.1 (most capable), Opus 5.5 (Opus line), **Sonnet 5.5** (speed and capability for agents), Haiku 4.5 (small) | 1M (Haiku 200K) | Fable 5.1 $10 / $50 · Opus 5.5 $4 / $20 · **Sonnet 5.5 $2 / $10** (cache reads $0.20) · Haiku 4.5 $1 / $5 | Adaptive thinking with `effort` levels. Server-side **compaction** (beta). **Mid-conversation system messages** that don't break the prompt cache (good for our situation report). Batch API at ~50% off. Task budgets. Thinking blocks are bound to the producing model and to an unedited history ("preserved thinking"), so harnesses must be **append-only** within a conversation and must not carry reasoning blocks across models. Forced `tool_choice` is unsupported on the newest models, so steer with the prompt. Fable 5.1 requires 30-day retention (not ZDR-eligible). |
| **OpenAI GPT-6** | GPT-6 Astra (flagship, Sep 3 2026), GPT-6 Sol (mid), **GPT-6.1 Sol** (Sep 29 2026; "nearly matches Astra on agentic coding, computer use and professional work at one-fifth of Astra's prices"), GPT-6 Luna (small) | ~1M (Astra 1M; Sol and Luna 1.05M) | Astra $10 / $50 (long context > 272K costs more) · Sol $2 / $10 · Luna $0.10 / $0.50 (Sol and Luna halved on 2026-09-22) | Reported: GPT-6.1 Astra was shelved after alignment regressions. Available in the API, ChatGPT Work and Codex. Luna-class pricing makes it attractive for the `fast` tier (extraction, triage) if evals hold up. |
| **DeepSeek** | **V4-Pro** (GA 2026-08-13; MoE 1.6T total / 49B active), **V4.1** (Sep 2026; V4.1 Flash is open-weights, multimodal) | 1M | Low (check current) | Three reasoning-effort levels (low, high, max). API adds **OpenAI Responses API compatibility**. API model name `deepseek-v4-pro`. Open weights make it a self-host candidate. |
| **Google Gemini** | Gemini 3.1 Pro (preview), Gemini 3 Flash; **Gemini 3.5 Pro** reported launched 2026-07-17 (2M context, ~$1.25 / $10) | 1M–2M | See left | Gemini 2.5 models are scheduled for shutdown in Oct 2026. Strong multimodal and long context. |

The user's brainstorm mentioned "GPT 6.1 Sol" and "Sonnet 5.5". Both are real, current models as of this writing.

**Implications**
- A mid-tier model (Sonnet 5.5 or GPT-6.1 Sol, both ~$2 / $10) is the natural `coach` tier. Small models (Luna, Haiku, DeepSeek Flash) are `fast` tier candidates. A frontier tier (Fable 5.1, Astra, Opus 5.5) is only worth paying for in the `deep` tier, for occasional plan building or review.
- All providers have quirks: reasoning-block binding, compaction formats, cache semantics, forced tool use. Hence: tiers behind an abstraction, append-only epochs, model switches only at epoch boundaries (SPEC §5.3, §5.7).
- Retention and ZDR eligibility differ by model and feature, so they must be surfaced in settings (SPEC §13).

**Sources:** Claude model table from Anthropic's API reference skill (cached 2026-09-25) · [The New Stack: GPT-6.1 Sol](https://thenewstack.io/openai-gpt-6-1-sol/) · [OpenAI on X: GPT-6.1 Sol](https://x.com/OpenAI/status/2104986133004505373) · [Gizmodo: OpenAI pivots to GPT-6.1 Sol](https://gizmodo.com/with-no-astra-to-release-openai-pivots-to-new-gpt-6-1-sol-model-2000819044) · [eesel: GPT-6 Astra pricing](https://www.eesel.ai/blog/gpt-6-astra-pricing) · [LLM Gateway: GPT-6 Sol & Luna at half the price](https://llmgateway.io/changelog/gpt-6-sol-luna) · [computingforgeeks: GPT-6 Sol/Luna](https://computingforgeeks.com/gpt-6-sol-luna-released-features-benchmarks/) · [Froala: DeepSeek API guide & V4 migration](https://froala.com/?p=87257) · [LLM Reference: DeepSeek V4.1](https://www.llmreference.com/model-family/deepseek-v4.1) · [Tech Insider: DeepSeek V4 Pro setup](https://tech-insider.org/how-to-set-up-deepseek-v4-pro-2026/) · [Gemini API model lineup](https://claw.aguidetocloud.com/google/gemini-api/models/) · [Gemini 3.5 Pro report](https://ecosistemastartup.com/?p=93104)

---

## A.2 Agent harnesses (open source and vendor)

| Harness | License / language | Shape | Strengths for us | Weaknesses for us |
|---|---|---|---|---|
| **Hermes Agent** (Nous Research, launched Feb 2026) | MIT · Python | Persistent personal agent: memory (agent-curated with periodic nudges; FTS5 session search with LLM summarization), autonomous skill creation (Agent Skills format), built-in **cron** with delivery to any platform, subagents, **messaging gateway** (Telegram, Discord, Slack, WhatsApp, Signal), **7 terminal backends** (local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox; Modal and Daytona hibernate when idle), many providers | Nearly every *behavioral* primitive we want. Best-in-class for the **Phase 0 brain testbed**. | Single-user assistant design; large general-purpose surface; Python; no app UI, view publishing or same-mind voice calls. |
| **OpenClaw** (OpenClaw Foundation, 501(c)(3)) | MIT · TypeScript (Node 24+) | Local **Gateway** control plane; agent runtime built on pi; workspace files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`); **heartbeat** (default every 30 min, checklist in `HEARTBEAT.md`); 20+ messaging channels; native nodes (macOS, iOS, Android) with voice, camera and **Canvas** (agent-controlled WKWebView surface hosting HTML and A2UI) | The closest existing product to "a persistent agent that messages you and controls a UI surface". Great pattern source (SOUL.md, heartbeat, Canvas). | **Security track record:** CVE-2026-25253 (cross-site WebSocket hijacking, CVSS 8.8), 138+ CVEs disclosed, Snyk found 36% of 3,984 ClawHub skills with flaws (13.4% critical), Censys found 21,000+ publicly exposed instances. Tools run on-host by default. Heavy. |
| **OpenCode** (Anomaly) | MIT · TypeScript | Coding agent with **client/server architecture**: `opencode serve` is a headless HTTP server with an OpenAPI 3.1 spec and a generated `@opencode-ai/sdk`. 75+ providers via models.dev. Primary agents (build, plan) and subagents defined in markdown or JSON with per-agent model, prompt and permissions. Plugins. MCP. | Embeddable as a server; best multi-provider coverage. | Coding-centric throughout; no documented sandbox; session model doesn't fit one continuous relationship; we'd fight it for turn and context control. |
| **pi-mono** (Mario Zechner; packages now under `@earendil-works`) | MIT · TypeScript | Libraries: `pi-ai` (unified multi-provider LLM API), `pi-agent-core` (agent runtime with tools and state), `pi-durable` (persistent conversations and tasks), the pi coding agent (minimal four-tool core: read, write, edit, bash), TUI and web UI libs | Minimal, embeddable, proven inside OpenClaw. A candidate base for our engine (Spike S1). | Deliberately omits subagents and permissions, which we'd write anyway. |
| **Codex app-server** (OpenAI) | Apache-2.0 · Rust (`openai/codex/codex-rs/app-server`) | JSON-RPC 2.0 protocol that powers the Codex IDE and desktop clients; transports: stdio JSONL, WebSocket, Unix socket, headless daemon | Production-grade embeddable harness. | Coding-specialized; OpenAI-centric; Rust. |
| **OpenAI Agents SDK** (Apr 15 2026 update) | MIT · Python / TS | "Model-native harness" with **native sandbox execution**, configurable memory, filesystem, shell and patch tools, MCP, `AGENTS.md`, workspace manifests, snapshotting and rehydration | Strong, modern, permissive. | OpenAI-first; other providers are second-class. |
| **Claude Agent SDK** | TS SDK under Anthropic Commercial Terms (Python repo MIT, usage under Commercial Terms) | The Claude Code harness as a library: built-in tools, subagents, hooks, permissions, sessions | Excellent harness quality. | Claude-only; licensing isn't cleanly OSS for our core. |
| **Claude Managed Agents** (beta header `managed-agents-2026-04-01`) | Hosted service | Agent, Environment, Session, Events; Anthropic runs the stateless harness loop; per-session sandbox (Anthropic cloud, or **self-hosted sandboxes** on Cloudflare, Daytona, Modal, Vercel); **scheduled deployments** (cron); **outcomes** (grader-driven iteration); multi-agent sessions; memory stores; **"dreaming"** (announced 2026-05-06: between-session memory consolidation over up to 100 transcripts, output for review) | Functionally the closest *hosted* match to our runtime. The best pattern source for the trust split (loop trusted, tools sandboxed) and for consolidation. | Claude-only; vendor-hosted; beta; **not eligible for ZDR or HIPAA BAA**. Candidate for an *optional engine adapter* in a hosted Claude deployment. |
| **ChatGPT Work / workspace agents** (Jul 2026) | Proprietary product | Cloud agent mode in ChatGPT: plugins, schedules, multi-hour tasks; workspace agents are Codex-powered with tools, skills, memory and schedules | The "OpenAI Work mode" the brainstorm referenced: evidence that persistent, scheduled, workspace-backed agents are now mainstream UX. | Not embeddable; not open. |

**Patterns adopted (SPEC references)**
- Markdown workspace identity files: `AGENTS.md`, `SOUL.md`-style persona, memory files (OpenClaw, Hermes) → SPEC §6.1
- Heartbeat with a checklist file (OpenClaw) → SPEC §5.5 (daily rather than every 30 min, for cost)
- Agent-curated memory with nudges, plus session search (Hermes) → SPEC §5.3.3, `search_history`
- Autonomous skill creation (Hermes) → SPEC §8 `[SK-2]`
- Trusted loop with an untrusted sandbox (Managed Agents) → SPEC §4.2
- Dreaming / consolidation (Managed Agents, Hermes) → SPEC §5.3.5
- Agent-controlled web surface (OpenClaw Canvas) → SPEC §9 (with a much stricter sandbox and publish pipeline)

**Anti-patterns avoided:** on-host tool execution by default; unauthenticated or LAN-trusting gateways; WebSocket endpoints without Origin checks; an open skill marketplace without review.

**Sources:** [Hermes Agent README](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md) · [Hermes Agent landscape entry](https://landscape.jimmysong.io/projects/hermes-agent/) · [Hermes Atlas guide](https://hermesatlas.com/guide/) · [OpenClaw README](https://raw.githubusercontent.com/openclaw/openclaw/main/README.md) · [OpenClaw architecture (agentic-ai docs)](https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/openclaw/) · [OpenClaw Canvas docs](https://docs.openclaw.ai/platforms/mac/canvas) · [TechRadar: OpenClaw security risks](https://www.techradar.com/pro/here-are-the-openclaw-security-risks-you-should-know-about) · [OpenClaw known vulnerabilities](https://clawdocs.org/security/known-vulnerabilities) · [barrack.ai: OpenClaw security](https://blog.barrack.ai/openclaw-security-vulnerabilities-2026/) · [OpenCode serve docs](https://www.mintlify.com/anomalyco/opencode/cli/serve) · [OpenCode license](https://www.morphllm.com/anomalyco-opencode-license) · [pi-mono README](https://raw.githubusercontent.com/badlogic/pi-mono/main/README.md) · [Codex App Server docs](https://developers.openai.com/codex/app-server) · [OpenAI: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness) · [OpenAI: The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview) · [Managed Agents: self-hosted sandboxes](https://claude.com/de/blog/claude-managed-agents-updates) · [Claude "dreaming" explained](https://www.mindstudio.ai/blog/what-is-claude-dreaming-anthropic-managed-agents) · [OpenAI: workspace agents in ChatGPT](https://openai.com/index/introducing-workspace-agents-in-chatgpt/) · [ChatGPT Work explained](https://www.mindstudio.ai/blog/what-is-chatgpt-work-mode-openai-super-app)

---

## A.3 Voice: realtime and cascaded

| Option | Type | Status (Oct 2026) | Notes |
|---|---|---|---|
| **OpenAI `gpt-realtime-2`** (May 7 2026) → **`gpt-realtime-2.1` and `-mini`** (Jul 6 2026) | Native speech-to-speech | GA | GPT-5-class reasoning in voice; 128K context; adjustable reasoning effort; parallel tool calls; audible **preambles** while thinking or acting; ≥ 25% lower p95 latency in 2.1. WebRTC, WebSocket and SIP. **Sideband server connection** via `call_id`, so tools and instructions stay server-side while media flows client ↔ OpenAI. Pricing: $32 / $64 per MTok audio in/out (cached audio input $0.40); budget ~$0.06–0.11 per minute flagship, ~$0.02–0.05 mini. |
| OpenAI `gpt-realtime-whisper` | Streaming STT | GA | Voice-note and cascaded transcription. |
| **Google `gemini-3.1-flash-live(-preview)`** (Mar 26 2026) | Native audio-to-audio | Preview | 90+ languages; affective dialog; ephemeral tokens for client WebSockets (default 30 min expiry); tool-use behavior changed from 2.5. Gemini 2.5 Flash native audio is discontinued Dec 13 2026. |
| **Anthropic** | — | **No native realtime speech API.** Claude apps and Claude Code have voice mode (TTS via ElevenLabs). | Claude-in-voice means a cascaded pipeline (STT → Claude → TTS), reported at sub-700 ms with a well-built stack. |
| **ElevenLabs Agents** | Hosted cascaded platform | GA | Turn-taking, interruption, STT plumbing; **custom LLM via server integration**; best-in-class voices. |
| **Pipecat** (BSD-2) / **LiveKit Agents** (Apache-2.0) | OSS voice frameworks | Mature | Pipecat: composable pipeline, Smart Turn v3. LiveKit: WebRTC SFU plus transformer turn detector, SIP. Either works for our cascaded mode. |
| **Kyutai** Unmute / Moshi / Pocket TTS / TTS 1.6B | OSS | Mature | Unmute wraps *any* text LLM with streaming STT (semantic VAD) and TTS. Moshi is full duplex (~160–200 ms). Pocket TTS (Jan 2026, 100M parameters) runs in realtime on CPU, which suits fully local self-host. |

**Implications:** for calls, use a realtime S2S model as the *voice* with a workspace-compiled briefing and a `consult_coach` tool back to the *brain* (SPEC §11.2). Use a cascaded pipeline when the brain must be the speaker, when the provider lacks realtime, or for fully local setups. Voice notes are cheap and should ship first.

**Sources:** [OpenAI: Advancing voice intelligence with new models in the API](https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/) · [DataNorth: gpt-realtime-2.1](https://datanorth.ai/news/openai-releases-gpt-realtime-2-1-voice-models) · [OpenAI Realtime server-side controls (sideband)](https://developers.openai.com/api/docs/guides/realtime-server-controls) · [Fora Soft: Realtime API pricing](https://www.forasoft.com/blog/article/openai-realtime-api-pricing) · [Layer3 Labs: Realtime API pricing](https://www.layer3labs.io/guides/openai-realtime-api-pricing) · [Gemini 3.1 Flash Live overview](https://pasqualepillitteri.it/en/news/490/gemini-3-1-flash-live-google-audio-ai-model) · [Gemini 3.1 Flash Live model ID & quickstart](https://blog.laozhang.ai/en/posts/gemini-3-1-flash-live-api.md) · [Gemini Live API WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [Vertex: Gemini 2.5 Flash Live API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api) · [TechCrunch: Claude Code voice mode](https://techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/) · [The Decoder: Claude uses ElevenLabs for speech](https://the-decoder.com/anthropics-claude-uses-elevenlabs-technology-for-speech-features-rather-than-an-in-house-model/) · [Claude voice stack 2026](https://claudexia.tech/blog/claude-voice-realtime-stack-2026) · [ElevenLabs Agents Platform docs](https://elevenlabs.io/docs/conversational-ai) · [LiveKit vs Pipecat](https://livekit.io/field-guides/guide/livekit-vs-pipecat) · [Fora Soft: Pipecat vs LiveKit Agents](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents) · [Kyutai Unmute](https://kyutai.org/2025/05/22/unmute.html) · [Kyutai](https://kyutai.org/)

---

## A.4 Skills and agent instruction standards

- **Agent Skills** (`SKILL.md`: YAML front-matter with name and description, a markdown body, and optional scripts and references; progressive disclosure that loads ~30–50 tokens per skill at startup). Originated at Anthropic, now an open standard at agentskills.io, adopted by 26+ platforms including Claude, OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor, VS Code, OpenClaw and Hermes.
- **`AGENTS.md`**: a widely adopted convention for agent operating instructions, supported by the OpenAI Agents SDK, Codex and OpenClaw among others.

**Implications:** our skills and workspace manual use these formats, so the brain is portable across harnesses: the Phase 0 testbed now, and any future engine adapter.

**Sources:** [agentskills.io](https://agentskills.io/home) · [inference.sh: Agent Skills overview](https://inference.sh/blog/skills-agent-skills-overview) · [Atlan: What are agent skills](https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/)

---

## A.5 Generative and agent-driven UI protocols

| Protocol | Approach | Status | Relevance |
|---|---|---|---|
| **MCP Apps (SEP-1865)** | Tools return `ui://` resources: **interactive HTML rendered in sandboxed iframes**; the iframe talks to the host via **JSON-RPC 2.0 over postMessage** | First official MCP extension (`io.modelcontextprotocol/ui`), stable 2026-01-26, official in the 2026-07-28 MCP release; built by Anthropic and OpenAI together; shipped in Claude, ChatGPT, VS Code, Goose and Cursor | **Our view bridge is modeled on it** (SPEC §9.2), so coach views can later be exposed as MCP Apps. |
| **A2UI** (Google) | Agent sends **declarative JSON** describing UI intent; the client renders with its *own* trusted component catalog (Lit, Flutter, Angular, React) | v0.8 public preview | Safer but catalog-capped. We use the declarative idea only for micro-UI (quick replies, forms, notification actions). |
| **AG-UI** (CopilotKit) | **Event-stream protocol** between agent backend and frontend: text deltas, tool-call events, state deltas, lifecycle (~17 event types) over SSE or WebSocket | Widely integrated (LangGraph, CrewAI, Mastra, Pydantic AI, …) | Our gateway stream vocabulary is modeled on it (SPEC §15). |
| **OpenClaw Canvas** | Agent-controlled webview (HTML/CSS/JS plus A2UI); agent can navigate, eval JS, snapshot | Shipping (macOS) | Shows how capable "agent owns a UI surface" is, and why it needs isolation. |

**Sources:** [MCP Apps spec overview](https://www.morphllm.com/mcp-apps) · [MCP Apps: when should your server render UI](https://mcp.directory/blog/mcp-apps-spec-2026-when-should-your-server-render-ui) · [Google: Introducing A2UI](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/) · [A2UI GitHub](https://github.com/google/A2UI) · [CopilotKit: Introducing AG-UI](https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users) · [Codecademy: How AG-UI works](https://codecademy.com/article/ag-ui-agent-user-interaction-protocol) · [OpenClaw Canvas](https://docs.openclaw.ai/platforms/mac/canvas)

---

## A.6 Sandboxes

| Provider | Isolation | Persistence | Notes |
|---|---|---|---|
| **E2B** | Firecracker microVMs | Pause/resume, snapshots | ~0.7 s create and resume; per-second billing (~$150/mo floor); BYOC for enterprise |
| **Daytona** | Docker (Kata or Sysbox optional) | Fork, pause/resume, snapshots | Warm pools (sub-100 ms claims); **self-hostable**; used by Hermes and Managed Agents self-hosted sandboxes |
| **Modal** | gVisor | Filesystem and memory snapshots; scale-to-zero | Python-first; used by Hermes |
| **Cloudflare / Vercel / Blaxel** | Various | Various | CPU-hour list prices roughly $0.08–0.15 |
| **Local Docker (+ gVisor `runsc`)** | Container | Volume | Our self-host default |

**Implications:** `SandboxProvider` interface; local Docker for self-host; a hibernating provider for hosted mode (Phase 3). The workspace lives on a persistent volume, and exec environments can be ephemeral.

**Sources:** [LogRocket: comparing sandbox platforms](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/) · [Superagent: AI code sandbox benchmark 2026](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026) · [Run Claude Managed Agents on Daytona](https://www.daytona.io/docs/en/guides/claude/claude-managed-agents.md)

---

## A.7 Health and fitness data access

- **Samsung Health:** no public cloud API. Since 2024 it **writes to Android Health Connect**, where an app with the user's permission can read it on-device. Users can download their personal data as **CSV or JSON per category** (exercise, heart rate, sleep, steps, …). The brainstorm's screenshot-first approach is pragmatic.
- **Strava:** Nov 2024 API agreement banned using API data in AI models. The **API Policy effective 2026-06-01, §5.3** goes much further: *"You may not use the Strava API Materials or Strava Data, directly or indirectly, in connection with the development, training, evaluation, or operation of any AI Application"*. That covers prompts, embeddings and RAG, including derived and anonymized data. The developer program is now a paid subscription (~$11.99/mo). Strava's sanctioned route for "Strava data in AI" is **its own MCP server** with Claude.
- Expect other platforms to follow Strava's lead; check each platform's current terms. **Athlete-initiated exports and on-device OS health stores (Health Connect, HealthKit) are the robust paths.** Any platform integration needs legal review (SPEC §10.5).

**Sources:** [Samsung Health export guide](https://takeoutday.org/guides/how-to-export-samsung-health-data) · [samsung-health-mcp (community)](https://github.com/davidmosiah/samsung-health-mcp) · [Terra: Strava API changes 2026](https://tryterra.co/blog/strava-api-changes-2026) · [TechRepublic: Strava tightens API access](https://www.techrepublic.com/article/news-strava-api-scraping-crackdown/) · [CyberInsider: Strava API policies](https://cyberinsider.com/strava-tightens-api-policies-to-bolster-user-privacy-and-security/) · Further reading, not reviewed in full: [Sahha: Health API AI restrictions (Aug 2026)](https://sahha.ai/blog/health-api-ai-restrictions/)

---

## A.8 Competitors and positioning

| Product | Approach | Gap we exploit |
|---|---|---|
| **Runna** (Strava-owned since Apr 2025) | Coach-designed plan templates plus algorithmic adaptation; states its plans are *not* AI-created. Injury-risk criticism in the press (the5krunner, Feb 2026). | No reasoning over context, no relationship, no conversation. |
| **Strava** (Athlete Intelligence) | Platform play; summaries of activities; a sanctioned MCP for AI assistants | Not a coach; restricts others' AI use of its data. |
| **SensAI** | LLM coach covering running, strength and recovery | Closed; fixed UI; not model-agnostic or self-hostable. |
| **Athletica, AI Endurance** | Physiological modeling | Model-centric, not conversation-centric. |
| **TrainingPeaks, Garmin Run Coach** | Analysis depth / device-native adaptive plans | Rule-based adaptation, device lock-in. |

**Our position:** the only **open-source, model-agnostic, agentic** coach, where the AI owns its memory, data model, schedule and UI, with natural (screenshot, voice, chat) input and no integrations required.

**Sources:** [the5krunner: Is Runna AI?](https://the5krunner.com/2026/09/28/is-runna-ai/) · [the5krunner: Runna and injury](https://the5krunner.com/2026/02/21/runna-ai-marathon-training-injury/) · [SensAI: best AI marathon training apps 2026](https://www.sensai.fit/blog/best-ai-marathon-training-apps-2026) · [T3: Strava in 2026](https://www.t3.com/active/strava-2026-future-and-challenges)

---

## A.9 Client platform constraints

- **iOS PWA Web Push** works only for home-screen-installed web apps (iOS 16.4+). It can't be prompted automatically, and developers report subscriptions disappearing. Android PWAs can prompt install and push reliably.
- **Implication:** PWA for velocity in Phase 1 (with an install step in onboarding), then an Android-first Capacitor shell in Phase 2 (SPEC §14).

**Sources:** [MagicBell: PWA iOS limitations](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) · [Webscraft: PWA push on iOS in 2026](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en) · [Pushpad: iOS web push requirements](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications)

---

## A.10 Open items to re-verify at build time

1. Exact API model IDs for GPT-6.1 Sol, GPT-6 Luna and the DeepSeek V4.1 variants (the `config/models.yaml` examples in SPEC §5.7 are illustrative).
2. Whether Anthropic ships a realtime speech API (would add a third call-voice option).
3. Gemini Live tool-calling semantics in 3.1 versus our `consult_coach` asynchronous pattern.
4. MCP Apps bridge method names in the 2026-07-28 MCP release (align `packages/ui-kit` bridge naming).
5. Current Health Connect data types that Samsung Health syncs (exercise routes, HR samples, running dynamics).
6. Strava's and other platforms' terms for MCP-based access by third-party agents.
