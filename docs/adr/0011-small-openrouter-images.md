# ADR 0011: Bounded OpenRouter images and owned workspace assets

- Status: accepted (2026-10-08).
- Context: generated medal artwork needed an actual provider and a readable
  asset for coach-authored views. Existing generation accepted only direct
  Google/OpenAI-compatible endpoints, stored inaccessible private blobs, and
  required the avatar permission plus a reactive turn. Skills now describe the
  app (ADR 0010); image style guidance belongs to presentation/capability docs.
- Decision [MOD-1] [COST-1] [SEC-1] [SEC-4] [WS-3]: add OpenRouter's dedicated
  image contract behind `ImageProvider`, reuse scoped encrypted account keys,
  and return both an owned blob and a versioned workspace PNG. Existing direct
  adapters remain alternatives; keys and upstream diagnostics stay trusted.
- Default: `openai/gpt-image-2.5-flare`, medium, 816 square upstream, transparent,
  normalized to 512 PNG. Fixed server parameters prevent auto/high/4K or bulk
  requests. A short operator-overridable pixel-art brief supplies the app's style.
  The model still chooses the subject and whether art helps. Research of 59 API
  models and workload samples favors this balance over pure lowest price; see
  [measurements and budget rationale](../image-generation-research.md).
- Price preflight pins an endpoint with no fallback. Fixed-price and vetted
  token-price profiles reserve cost before dispatch within a $0.02 default
  ceiling. Unknown pricing fails closed. Image and total budgets apply together,
  are rechecked after pricing, and serialize attempts. Unknown/failed attempts
  remain counted; reported overruns are counted and pause that cached client.
  Reservations are not invoices. Durable replay markers recover a completed
  blob without repeating the paid request [RT-6].
- Images permission is independent of avatar changes: `requested` by default,
  `off`, or athlete-enabled `automatic`, with a separate $0.25 monthly allowance
  inside overall limits. Automatic includes scheduled/follow-up head turns and
  respects pause; helpers/consolidation cannot generate. The coach cannot edit
  controls or choose paid parameters. Identity changes retain existing opt-in.
- Generation does not deliver, apply an avatar, publish UI or earn an award.
  `exports/images/<sha>.png` can be read/inspected and copied into view assets;
  normal isolation, manifest, preview, publication, export/delete and undo apply.
  Returned costs distinguish reserved from reported charges [UI-2] [WS-4].
- Alternatives rejected: CSS-only medals as the whole solution; an image-only
  vendor account requirement; exposing arbitrary size/quality/model in tool
  arguments; unpriced token endpoints; blind paid retry/fallback; a fixed image
  versus LLM spending ratio (usage and value vary).
- Validation [EV-1]: provider fixtures, scoped credential rotation/ownership,
  permission/allowance and mid-preflight changes, replay, binary workspace
  materialization, generated gallery publication and browser controls. Live
  synthetic samples certify the tested OpenRouter request/settings, not all
  prompts/providers or future model prices. Release 0.3.5 advertises the app
  capability; no default gallery or training-data migration [WS-9].
