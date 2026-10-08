# ADR 0005: Optional coach identity and independent image generation

- Status: accepted (2026-10-07).
- Context: an athlete may ask the coach to choose a name/avatar. Conversation vision and image generation are independent capabilities. Coaching remains the purpose of the product; identity must not become an intake workflow.
- Decision: reuse `set_preferences` for name/avatar and add one general square `generate_image` tool behind `ImageProvider`. Athlete opt-in defaults off; only requested reactive coach turns can mutate identity or generate images. Settings retains manual rename/reset and revocation. Images are private owned blobs, normalized to still raster PNGs; never remote URLs. Generation does not automatically publish, send or apply an avatar. A progressive skill explains scope, disclosure, memory, preview and unavailable services [UI-1] [MOD-1] [SEC-1] [SEC-4].
- Providers: two small bounded REST adapters implement Google's documented Gemini generateContent image contract and the OpenAI-compatible Images contract. They do not change the existing SDK-backed conversation adapters (ADR 0001). Endpoint/model/key selection belongs to the deployment, never tool input. Google retired Imagen from its Gemini API; configuration uses a current image-capable Gemini model. No live provider conformance is claimed by fixture tests.
- Costs: reserve the configured conservative attempt estimate before external dispatch, include it in daily/monthly usage, and keep failed/unknown attempts counted. A durable attempt marker prevents automatic redispatch after an uncertain interruption. No fallback/retry silently spends again. The estimate is operator-maintained and not billing reconciliation [COST-1] [RT-6].
- Persistence: account settings/audit store identity; workspace persona notes may record agreed style. Existing profiles and views are preserved. Blob export/delete use the existing per-athlete lifecycle, with image-attempt namespace cleanup [WS-4] [SEC-6]. Current settings override a frozen older name in the situation report. Permission never changes via a coach tool.

Contract references: [Google image migration](https://ai.google.dev/gemini-api/docs/imagen), [Google generateContent](https://ai.google.dev/api/generate-content), [OpenAI Images](https://developers.openai.com/api/reference/resources/images/methods/generate).

Image provider support, generation permissions and asset materialization are extended by [ADR 0011](0011-small-openrouter-images.md); identity application rules remain as recorded here.

Clarification (0.3.6, [RT-3]): athlete input injected into an active background
turn gives that turn a reactive tool context. Requested identity/image work is
not conditional on a live app connection; the original turn trigger remains in
the audit trace. This fixes an explicit request being refused solely because
the turn began as an upgrade follow-up.
