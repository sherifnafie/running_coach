# Small-image model selection, 8 October 2026

The workload is occasional 48–96px avatars and achievement artwork: original
pixel-art motifs, clear silhouettes, consistent palettes, circular cropping
and useful transparent PNGs. It is not product photography, long text inside
images, image editing or 4K illustration.

## Research and measured samples

Inspected all **59 models** in OpenRouter's [Image Models API](https://openrouter.ai/api/v1/images/models)
and their endpoint prices/capabilities. This is the dedicated image API catalog,
not a claim that every chat-based image route was exhaustively tested. The
[general image list](https://openrouter.ai/models?output_modalities=image) and
[benchmarks](https://openrouter.ai/benchmarks/media/images) supplied context.
The photographed objects, multilingual text and reference-preservation tests
are useful instruction-following evidence, but not pixel-art or small-icon
rankings. New Flare is absent from those particular benchmark pages; don't
infer that absence means poor performance.

Generated the same fictional fox and bronze/shoe medal through OpenRouter,
with a shared pixel-art brief, one image, pinned provider and no retries.
Figures below are **observed bills, not token-rate guesses**, for two examples
per setting. Quality observations are a small manual review, not a calibrated
benchmark. The medium comparison used a shorter brief without a painted
background, so its presentation difference is partially confounded by prompt.

| Model / settings | Observed USD per image | Generation observations |
|---|---:|---|
| GPT Image 2.5 Flare, 816 square, low | 0.005585–0.005615 | Friendly, readable forms; transparent output. About 10 s in these samples. |
| **GPT Image 2.5 Flare, 816 square, medium** | **0.011885–0.011915** | Clearer small shading/features and a recognizable medal motif. Two timings were 10 s and 79 s; don't promise a fixed latency. |
| GPT Image 1 Mini, 1024 square, low | 0.002358–0.002370 | Cheapest tested; recognizable but rougher, plainer pixel-art faces. About 9 s. Medium was not independently sampled. |
| Recraft V4.1 Flash, default ~1K square | 0.007 | Fast and adequate; less faithful medal/ribbon layout in these samples; no native editing/reference support. |
| Seedream 5.0 Flash, 1K square | 0.018 | Good shoe/medal detail, but little benefit over Flare for this small display at a higher price. About 11 s. |

Pricing sources: [Flare endpoint](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints),
[Mini endpoint](https://openrouter.ai/api/v1/images/models/openai/gpt-image-1-mini/endpoints),
[Recraft](https://openrouter.ai/recraft/recraft-v4.1-flash),
[Seedream endpoint](https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-0-flash/endpoints).
OpenAI's [generation guide](https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency)
also distinguishes quality/size and input/output charges; its retrieved low
816-square calculator estimate (171 output tokens) matched the measured bills.
The medium samples used 384 output image tokens. No partial-image streaming or
reference-image charges were incurred.

Other inexpensive possibilities considered: FLUX.2 Klein 4B is priced per
megapixel (0.014 at the benchmark's 1MP output); Gemini Flash Lite uses token
pricing and benchmark examples around 0.034, not a flat cheap per-image quote.
Ming Image 0.1 Design is [currently free](https://openrouter.ai/inclusionai/ming-image-0.1-design),
but chooses its own dimensions and rejects requested size/aspect ratios. It is
not a suitable default for this controlled square-asset contract. Several Krea
entries had no usable price data and Muse had no active endpoint in this API
snapshot; neither is silently treated as free or a verified available route.

**Decision:** default to Flare **medium**, fixed 816×816 upstream and 512×512
normalized output. The modest price premium is worthwhile for these rare,
lasting assets. Low remains a deployment option. This is a practical choice
from limited workload samples, not a universal claim of model superiority.

## Artwork versus coaching spend

Aim for artwork to be roughly **5–10% or less of normal coaching/model spend**
over a useful period, not on each individual call. This is a planning guideline,
not a coded ratio or a monthly quota. An initial avatar is amortized across
months. Tentative usage is one initial avatar and 0–3 medals/other assets in a
month; it is fine for a month to have none.

Read-only aggregate app telemetry (two early setup/testing days; no messages or
athlete identities queried) showed Haiku coach-turn median 0.001377 / mean
0.004500 USD, helper median 0.022570 / mean 0.028471, consolidation median
0.010625 / mean 0.010435. The current cheaper model mix may differ.

An **illustrative** six turns/day, weekly helper and daily consolidation gives
about 0.65–1.24 USD/month from those medians/means. It is not a steady-state
forecast. Two to four medium Flare images cost about **0.024–0.048 USD/month**:
roughly 2–7% of that combined spend. With only 0.20 USD of model spend, four
images instead reach about 19%: lower image frequency/allowance or low quality
can be sensible. Voice is a separate optional cost and excluded here.

Medium versus low adds only about 0.025 USD for four images/month. Conversely,
one medium image costs around nine median Haiku coach turns or half a median
helper run. This is why frequency and purpose matter more than minimizing the
last fraction of a cent per picture. Keep most resources available for coaching,
planning and research. The $0.25 image allowance is a safety ceiling, never an
expected spend or engagement target.

## Enforced request bounds and limitations

The model supplies a subject, not a model/size/quality/count. OpenRouter pricing
is checked before dispatch; requests pin the checked provider with no fallback.
The medium Flare profile reserves 512 output tokens (above the observed 384)
plus a UTF-8-byte upper bound for input tokens, within a $0.02 reservation
ceiling. Low reserves 256 output tokens. Unknown token-price profiles fail
closed. These are conservative **reservations**, not an upstream invoice
guarantee; final charges are saved separately, overruns count additionally and
pause that client. Failed/unknown attempts retain reservations and never retry
automatically. See [ADR 0011](adr/0011-small-openrouter-images.md).
