# Self-hosting OpenCoach

OpenCoach keeps each athlete's coach workspace, raw uploads and history on your server. The app and the coach-authored views are served on separate origins. You need Node ≥ 22.13, pnpm 10.28, Git and Python 3. Command isolation uses Linux unprivileged user namespaces by default; Docker is the alternative.

## Start

```sh
pnpm install --frozen-lockfile
pnpm build
export OPENCOACH_DATA_DIR=/absolute/path/to/data
OPENCOACH_DEMO=1 pnpm start
```

Open `http://localhost:8080` and enter the setup code printed at startup (also in `<dataDir>/setup-code.txt`, mode 0600). `pnpm start` runs from `apps/server`, so relative paths resolve there. Use absolute `OPENCOACH_DATA_DIR` and `OPENCOACH_CONFIG` paths. Treat the data directory as health data: keep it private and back it up.

## Configuration

Settings come from YAML (`OPENCOACH_CONFIG`, see `opencoach.config.example.yaml`) plus environment variables, which override YAML. The server does not load `.env` files; `.env.example` is for Docker Compose.

| Variable | Purpose |
|---|---|
| `OPENCOACH_DATA_DIR`, `OPENCOACH_CONFIG` | Data directory and YAML config |
| `PORT`, `VIEWS_PORT`, `HOST` | Listeners (defaults 8080, 8081, 0.0.0.0) |
| `PUBLIC_URL`, `VIEWS_URL` | Browser-facing origins of the app and the views; they must differ |
| `OPENCOACH_TRUST_PROXY` | `true`, or trusted proxy addresses (`loopback`, `10.0.0.0/8`), when a reverse proxy or tunnel fronts the server. Without it, all clients share the proxy's rate-limit bucket. |
| `OPENCOACH_DEMO` | `1` for the scripted demo coach |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | Pick default models for that provider |
| `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SEARXNG_URL` | Web search for the coach |
| `TELEGRAM_BOT_TOKEN`, `OPENCOACH_ADMIN_TOKEN` | Telegram channel; bearer token for `/admin/*` |
| `OPENCOACH_SANDBOX`, `OPENCOACH_ALLOW_UNSAFE_SANDBOX` | `local` (default) or `docker`; unsafe fallback for development only |
| `OPENCOACH_CHROMIUM_PATH` | Chromium for view previews, if not found automatically |

### Models

With one provider key and no `models` section, the server picks default tiers for that provider. With no keys and no explicit models, it runs the demo. With explicit tiers, an unavailable provider fails startup. Keys stay in the server process and never reach athlete sandboxes. Set `models.pricing` for models the server doesn't know, otherwise their cost counts as zero against budgets.

**OpenCode GO:** use `opencoach.config.opencode-go.example.yaml` and supply `OPENCODE_GO_API_KEY`. It runs DeepSeek V4.1 Flash on all tiers through the compatible provider, with thinking enabled, low effort for conversation and high effort for deep work. Vision is off because this is the text model; add a vision-capable route before relying on screenshot reading. In Compose, mount the YAML read-only and set `OPENCOACH_CONFIG` (see the comments in `docker-compose.yml`).

**MCP servers** are configured under `mcp.servers`. Their tools appear to the coach as `mcp__<server>__<tool>`, and their output is treated as untrusted. Tools can be allowlisted; helper access is off by default.

### Voice notes

Speech is configured separately from the coach model. An OpenAI key enables speech-to-text, text-to-speech and calls. A different provider or a local transcriber works too:

```yaml
voice:
  stt:
    provider: openai            # or openai-compatible with baseUrl (incl. /v1) implementing /audio/transcriptions
    model: gpt-4o-transcribe
    apiKeyEnv: OPENCOACH_SPEECH_API_KEY
```

Phones only allow microphone access over HTTPS. If speech isn't configured, the microphone button explains why instead of recording.

## Phone access and views

`PUBLIC_URL` and `VIEWS_URL` must be distinct origins the phone can reach. Use HTTPS through a reverse proxy or tunnel (Tailscale, Cloudflare Tunnel, Caddy, …) for passkeys, the microphone, installing the PWA and push. Proxy WebSocket upgrades for `/v1/stream`, preserve the original `Origin` header, and set `OPENCOACH_TRUST_PROXY`.

Views run in `<iframe sandbox="allow-scripts">` on the views origin with a restrictive CSP. Their data access goes through the gateway, which enforces each view's manifest. Without Chromium, the coach can't preview or publish view changes, but the existing views keep working.

Browser sessions use an HttpOnly cookie. State-changing requests need the app `Origin` and a session-bound `X-CSRF-Token` (the PWA handles this; other clients can get one from `GET /v1/auth/csrf`, or use a bearer session). Push uses VAPID keys in `<dataDir>/secrets/vapid.json`; keep that file across upgrades, and set `push.vapidSubject` to your contact address. Large uploads can resume over Tus at `/v1/uploads/resumable`.

## Sandboxes

The local provider checks for user, mount and network namespaces at startup. Coach commands see only `/workspace`, read-only `/raw`, `/history` and `/system`, read-only OS files and a private `/tmp`. They have no network access and get an allowlisted environment. If isolation is unavailable, startup fails unless `OPENCOACH_ALLOW_UNSAFE_SANDBOX=1` is set (development only). Python analysis libraries are used from `/opt/coach-python` when present (the Docker images install them).

**Docker sandbox:** build `docker/sandbox.Dockerfile` (`docker compose --profile sandbox-image build`) and set `OPENCOACH_SANDBOX=docker`. The athlete bind paths must be identical from the daemon's point of view. Daemon socket access gives the server control of Docker, so keep it out of athlete mounts.

**Compose:** `docker-compose.yml` runs the server image (uid/gid 1000; `.data` must be writable by it) with local namespaces inside the container. Ports are bound to loopback only. It sets `seccomp`, `apparmor` and `systempaths` to `unconfined` for the trusted server so it can create nested namespaces. Each athlete sandbox still drops capabilities, masks sensitive paths and has no network.

## Export, import and maintenance

Settings offers export, per-view history and revert, calendar-feed rotation and account deletion. Exports include the workspace, a consistent coach database, raw uploads and events; sessions and server secrets are excluded. CLI, run from the repository root with the same data and config paths as the server (stop the server before importing):

```sh
node apps/server/bin/opencoach.mjs setup-code
node apps/server/bin/opencoach.mjs export <athlete-id>
node apps/server/bin/opencoach.mjs import /path/bundle.tar.gz <new-athlete-id>
```

Upgrades keep each athlete's workspace and published views: new starter files never overwrite the coach's own versions, and harness prompts refresh at the next epoch. Back up the data directory before upgrading. SIGINT and SIGTERM shut the server down cleanly.
