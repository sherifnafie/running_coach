# OpenCoach

**A self-hosted, AI-native running coach.** An agentic LLM is the coach. It keeps a persistent workspace (your profile, training data, plan, notes, history), messages you proactively within limits you set, delegates work to helper agents, and authors the training screens you see. The app is the harness around it: chat, voice, uploads, sandboxed views, scheduling, safety rails and privacy controls.

You run the server yourself and open the PWA on a computer or phone. `SPEC.md` describes the full design.

<p>
  <img src="docs/images/demo-chat.png" alt="Mobile chat with the demo coach's welcome message and goal quick replies" width="240">
  <img src="docs/images/sample-today.png" alt="The Today view with sample data: an easy run, completion controls and a check-in" width="240">
  <img src="docs/images/settings-phone.png" alt="Personalization controls in mobile Settings" width="240">
</p>

## Screens

| Screen | What you can do |
|---|---|
| **Chat** | Talk to the coach, tap quick replies, send photos, files and voice notes. |
| **Today** | Today's workout, mark it done or skipped, a quick check-in. |
| **Calendar** | Planned workouts, activities and races; move a workout to another day. |
| **Plan** | The current block, weekly volume, key sessions and why the plan looks the way it does. |
| **Progress** | Distance, long runs, easy pace and consistency over time. |
| **Settings** | Language (English, Dutch, Arabic/RTL), theme, units, quiet hours, message and cost limits, privacy, devices, export and account deletion. |

Today, Calendar, Plan and Progress are the starter views. They are owned by the coach, who can change them or add new ones. Every change goes through automated checks before it's published, and you can revert any version. Chat and Settings belong to the app.

Optional: enable **Settings → Profile → Let my coach change its name and avatar**, then ask in chat. Names need no extra service; generated avatars use a separate image provider and AI budget. See [image setup](docs/self-hosting.md#optional-coach-name-avatar-and-generated-images).

## Quick start (demo, no API key)

Requirements: Linux (or WSL2) with unprivileged user namespaces, Node.js ≥ 22.13, pnpm 10.28, Git and Python 3. Chromium is optional; the coach needs it to preview and publish view changes (`OPENCOACH_CHROMIUM_PATH` if it isn't found automatically).

```sh
pnpm install --frozen-lockfile
pnpm build
export OPENCOACH_DATA_DIR="$PWD/.data"
OPENCOACH_DEMO=1 pnpm start
```

Open http://localhost:8080 and enter the setup code printed by the server (also saved in `.data/setup-code.txt`). Accept the three consents and create your coach. The first account is the admin; later accounts need an invite. To add another device, use pairing or a passkey from Settings.

The demo coach is scripted, not a language model. Try a goal quick reply, "I ran 5k today", or "plan" (which schedules a check-in). The training views stay empty because the demo doesn't write structured training data.

## Connect a real model

Keep the same `OPENCOACH_DATA_DIR` to keep your account. Export one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` and restart with `OPENCOACH_DEMO=0`. Keys stay in the server process and never reach the coach's sandbox. For tier models, limits, search, speech and MCP servers, copy `opencoach.config.example.yaml` and point `OPENCOACH_CONFIG` at it. The server does not read `.env` files.

**OpenCode GO** (DeepSeek V4.1 Flash) has a ready-made config:

```sh
export OPENCOACH_CONFIG="$PWD/opencoach.config.opencode-go.example.yaml"
export OPENCODE_GO_API_KEY=...   # use your shell or process manager
OPENCOACH_DEMO=0 pnpm start
```

This is the configuration that has been tested live. It is text-only, so screenshot reading needs a separate vision-capable model. Voice notes need a speech-to-text provider (see [self-hosting](docs/self-hosting.md#voice-notes)).

## Phone access and Docker

On a phone, `localhost` is the phone itself. Set `PUBLIC_URL` (the app) and `VIEWS_URL` (the isolated views) to two distinct HTTPS origins reachable from the phone. A reverse proxy or a tunnel such as Tailscale or Cloudflare Tunnel works, as long as it supports WebSockets. HTTPS is needed for passkeys, the microphone, installing the app and push notifications.

`mkdir -p .data && OPENCOACH_DEMO=1 docker compose up --build` runs the server in a container. It runs as uid 1000, so `.data` must be writable by that user. See [self-hosting](docs/self-hosting.md) for configuration, sandboxes, Docker, voice, backups and the CLI.

## Status

| Area | State |
|---|---|
| Web app and server | Implemented and tested end to end: accounts, passkeys, chat, uploads, views, settings, export and deletion. |
| Real-model coaching | Live-tested with DeepSeek V4.1 Flash on synthetic athletes. Coaching quality has not been evaluated systematically yet. |
| Voice, Web Push, Telegram, web search, MCP | Implemented, but not tested against the live services. |
| Fitness data | Chat, screenshots (needs a vision model) and file uploads (FIT, GPX, TCX). No Garmin or Strava cloud sync. |
| Native Android | A Capacitor shell with Health Connect sync exists, but it has never been compiled. See `apps/native/README.md`. |

## Troubleshooting

| Symptom | Check |
|---|---|
| Startup rejects sandbox isolation | You need Linux with unprivileged user namespaces, or the Docker sandbox provider. |
| No setup code | Codes exist only before the first account is created. Check that `OPENCOACH_DATA_DIR` points to the data directory you meant. |
| Views don't load on the phone | `VIEWS_URL` must be reachable from the phone (not `localhost`). |
| The coach says it's a demo | Export the key in the shell that starts the server and use `OPENCOACH_DEMO=0`. OpenCode GO also needs `OPENCOACH_CONFIG`. |
| Data gone after a restart | Use the same absolute `OPENCOACH_DATA_DIR` every time. |

## Development

```sh
pnpm typecheck
pnpm test                 # unit + integration (no model calls)
pnpm build                # UI kit + web app
pnpm test:e2e             # PWA against a real demo server in Chromium
pnpm eval:selftest        # offline eval controls
```

| Path | Contents |
|---|---|
| `packages/protocol` | Shared contracts (zod) |
| `packages/runtime`, `engine`, `tools` | The coach runtime, agent loop/providers, model-facing tools |
| `packages/store`, `workspace`, `sandbox` | Persistence, athlete workspace, command isolation |
| `packages/ui-kit`, `voice` | View kit, bridge and preview renderer; speech and calls |
| `packages/evals-sim`, `evals/` | Simulator, graders and scenarios ([evals/README.md](evals/README.md)) |
| `apps/server`, `apps/web`, `apps/native` | Gateway, PWA, Android shell |
| `seed/` | The coach's constitution, skills, workspace template and starter views |

Start with [AGENTS.md](AGENTS.md), [docs/status.md](docs/status.md) (current state and open work) and [docs/implementation.md](docs/implementation.md).
