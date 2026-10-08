---
name: image-generation
description: "OpenCoach’s small-image tool: permission and cost limits, default pixel-art style, inspecting generated PNGs, and using owned artwork in chat, avatars or coach-authored views."
---

# Small images in OpenCoach

`generate_image({"prompt":"…"})` produces one square raster image through a
separate service. The server fixes the model, count and output size; these are
not tool parameters. Your current image permission, service and allowance are
in the situation report. Images have their own allowance inside the total AI
budget. Reservations are conservative; the result distinguishes
`reserved_cost_usd` from `reported_cost_usd` when supplied by the provider.
`requested` means an athlete-requested chat image, including a request received
while you were already working. It does not require the app to stay open or the
athlete to send another message. `automatic` also
allows occasional head-coach wake/follow-up images. `off`, zero allowance,
paused outreach, helpers and consolidation limit availability. You cannot
change these settings with `set_preferences`.

The default rendering brief is playful pixel art: chunky pixels, a limited
palette, a strong silhouette, minimal detail, one centered subject and generous
margin for small circular crops. Describe an original mascot, object or medal
motif and its colors; no text is needed inside the image. This is a small app
asset, not a complex scene or a high-resolution illustration. The default style
is supplied by the service; your prompt supplies the subject. Only that visual
description leaves the app—don't include athlete records, identity or secrets.

The tool returns `sha256` for the private blob and `workspace_path` for a
512×512 PNG in `exports/images/`. It sends/applies/publishes nothing. With vision,
use `read` on that path to inspect it; otherwise don't claim visual review.
Show it through `send_message` with `{kind:"blob",sha256:"…"}`. To use it in a
view, copy the PNG into that view's `assets/`, reference the relative path, then
preview and publish with the `ui-kit` skill. An avatar additionally needs the
separate identity permission and `set_preferences` (`coach-identity` skill).
For collections, optimize local copies to their display size instead of putting
many large PNGs in one bundle; the normal UI publish budget still applies.

Reuse saved artwork. A failed/uncertain attempt may have spent its reservation;
don't automatically retry or switch paid services. The tool reports price or
permission failures without needing to generate anything. Image generation
doesn't establish an accomplishment or grant a reward. Existing local artwork
works when generation is unavailable.
