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
| `OPENROUTER_API_KEY` | Chat models (the coach uses the catalog's default model; deep background work uses the deep-tier default) |
| `OPENAI_API_KEY` | Voice only: speech-to-text, text-to-speech, calls |
| `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SEARXNG_URL` | Web search for the coach |
| `TELEGRAM_BOT_TOKEN`, `OPENCOACH_ADMIN_TOKEN` | Telegram channel; bearer token for `/admin/*` |
| `OPENCOACH_SANDBOX`, `OPENCOACH_ALLOW_UNSAFE_SANDBOX` | `local` (default) or `docker`; unsafe fallback for development only |
| `OPENCOACH_CHROMIUM_PATH` | Chromium for view previews, if not found automatically |

### Models

Chat models go through [OpenRouter](https://openrouter.ai) with one key ([ADR 0007](adr/0007-openrouter-only-chat.md)). Set `OPENROUTER_API_KEY` and leave `models` out: the coach, fast and deep tiers use DeepSeek V4.1 Flash. Deep work (multi-week plans, reviews and research) uses high effort; replies can be slower than Haiku. Override them with `providers.openrouter.defaultModel` and `deepModel`. Reasoning effort follows the situation: high for replies, check-ins and consolidation, low on voice calls. The model picker in Settings changes the coach's model; deep work keeps the deep-tier default. With no key and no explicit models, the server runs the demo. With explicit tiers, an unavailable provider fails startup. Keys stay in the server process and never reach athlete sandboxes.

The catalog lists the models the settings picker offers, with their capabilities and fallback prices. OpenRouter reports what each call cost, and that amount counts against budgets. The defaults:

| Model | Why |
|---|---|
| `anthropic/claude-haiku-5.5` | Smart, quick and careful (~$0.01 per chat turn in this harness, 1-hour prompt caching), reads screenshots; says when it doesn't know instead of guessing. |
| `deepseek/deepseek-v4.1-flash` (default for chat and deep work) | Very low cost, does more research on its own; guesses more than the others when it does not know. |
| `z-ai/glm-5.3-flash` | Similar cost, by far the lowest hallucination rate in its class; slower replies. |
| `xiaomi/mimo-v2.6-pro` | Strongest reasoning on a budget; slow to start answering. |
| `google/gemini-3.8-flash` | Fast all-rounder, best screenshot reading; about 5x the default cost. |
| `openai/gpt-6.1-sol` | Premium knowledge and quick replies; about 10x the default cost. |

Override the list with `providers.openrouter.models` and the default with `providers.openrouter.defaultModel`. Provider routing defaults to `dataCollection: deny` (no hosts that store or train on prompts) and `requireParameters: true`; DeepSeek pins fp8-or-better hosts so prompt caching keeps hitting, and Claude models switch on OpenRouter's request-level prompt caching. Set `routing` for stricter rules, e.g. `zdr: true`.

```yaml
providers:
  openrouter:
    defaultModel: deepseek/deepseek-v4.1-flash
    deepModel: deepseek/deepseek-v4.1-flash
    routing: { dataCollection: deny, requireParameters: true }
```

Other OpenAI-compatible endpoints (Ollama, vLLM, OpenCode GO) still work under `providers.compatible` with explicit `models.tiers`; set `models.pricing` for them, otherwise their cost counts as zero against budgets.

### Who pays: managed and own keys

Each person is either *managed* or brings their own key. Both show in Settings → AI and costs.

- **Managed** (default): calls use the server's OpenRouter key, or a separate key you assign to that person in Settings → Admin → People. A separate key can carry its own credit limit in the OpenRouter dashboard. Only an administrator can change a managed person's budgets and model, and the **monthly budget is a hard allowance**: once it is used up the coach pauses until next month and says so.
- **Own key**: the person clicks *Connect OpenRouter* (OAuth sign-in at OpenRouter) or pastes a key. They choose their model and set their own budgets; OpenRouter enforces any limit they put on the key. Disconnecting returns them to managed.

Keys are encrypted at rest with `<dataDir>/secrets/credentials.key` (keep it with the data directory; without it stored keys cannot be read), shown only as a masked hint, never passed to sandboxes or exports, and deleted with the account. Voice always uses the server's OpenAI key for now.

**MCP servers** are configured under `mcp.servers`. Their tools appear to the coach as `mcp__<server>__<tool>`, and their output is treated as untrusted. Tools can be allowlisted; helper access is off by default.

## Optional coach name, avatar and generated images

OpenRouter deployments now reuse the existing encrypted per-athlete keys for
small images; no extra vendor account/key is needed. Default: GPT Image 2.5
Flare, medium, 816 square, transparent PNG, normalized to 512 square. The brief
nudges original pixel art, clear silhouettes and circular cropping. Keys stay
trusted; only the visual prompt/style go to the provider.

Settings → Images controls generation: **Only when I ask** (default), **Off**,
or **Allow occasional coach images**. A separate $0.25 monthly allowance sits
inside total AI budgets; zero disables generation. The coach cannot edit these
controls. Automatic mode permits head-coach wake/follow-up images, respects
pause, and never allows helpers or consolidation. Switching off keeps old art.
Name/avatar application separately requires **Let my coach change its name and
avatar** in Profile and a requested chat turn; generating a preview doesn't.

Optional server override:

```yaml
imageGeneration:
  provider: openrouter
  model: openai/gpt-image-2.5-flare
  quality: medium # low is also supported; no auto/high/4K tool options
  costPerImageUsd: 0.02 # maximum reservation before a single dispatch
  timeoutMs: 120000
```

Set `OPENCOACH_IMAGES_ENABLED=false` to disable the service deployment-wide.
An explicit `apiKeyEnv` can supply a fallback image key; a scoped account key
still takes precedence. Custom OpenRouter base URLs are inherited unless an
image-specific `baseUrl` is supplied.

The image endpoint price is checked before dispatch, its provider pinned, and
fallback disabled. Fixed-price or vetted token profiles bound requests. Default
Flare reserves 512 image output tokens plus a UTF-8-byte upper bound for input
at the advertised rates. Unknown pricing, excessive reservations and exhausted
image/AI limits are refused before generation. Final bills may be lower than
the reservation; result fields distinguish them. Unknown/failed attempts remain
counted; no automatic paid retry. Overruns count additionally and pause that
client pending review. See [selection, measured prices and spending ratio](image-generation-research.md)
and [ADR 0011](adr/0011-small-openrouter-images.md).

The result has `sha256` for a private owned blob and `workspace_path` for a
versioned `exports/images/<sha>.png`. With vision the coach can read/inspect it,
attach the blob in chat, apply an authorized avatar, or copy the PNG into a
view's local assets and preview/publish. Generation performs none of those
presentation actions itself. Existing private blobs aren't exposed through
new unauthenticated routes. Files/blobs participate in existing export/delete.
Keep local display copies small enough for the normal view bundle limit.

Direct alternatives remain available with explicit configuration:

```yaml
imageGeneration:
  provider: google # or openai-compatible
  model: gemini-3.1-flash-image # use the selected vendor's model ID
  apiKeyEnv: OPENCOACH_IMAGE_API_KEY
  costPerImageUsd: 0.25 # operator-maintained conservative estimate, not a current price
  # baseUrl: https://api.openai.com/v1 # for openai-compatible
```

For direct services, set a sufficient image allowance for the configured
estimate. HTTPS is required except for loopback fixtures; no provider image
URLs are followed. Models/credentials aren't tool inputs. Never include
athlete records, identity, private uploads or secrets in a visual prompt.

Restart after configuration changes. Release 0.3.5 gives existing coaches an
upgrade note and capability skill; no custom views or training data are replaced.
Live synthetic OpenRouter samples verified the settings above; this doesn't
certify every prompt/provider or future price. The [OpenRouter contract](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
remains authoritative.

## Phone access and views

`PUBLIC_URL` and `VIEWS_URL` must be distinct origins the phone can reach. Use HTTPS through a reverse proxy or tunnel (Tailscale, Cloudflare Tunnel, Caddy, …) for passkeys, the microphone, installing the PWA and push. Proxy WebSocket upgrades for `/v1/stream`, preserve the original `Origin` header, and set `OPENCOACH_TRUST_PROXY`.

Views run in `<iframe sandbox="allow-scripts">` on the views origin with a restrictive CSP. Their data access goes through the gateway, which enforces each view's manifest. Without Chromium, the coach can't preview or publish view changes, but the existing views keep working.

Browser sessions use an HttpOnly cookie. State-changing requests need the app `Origin` and a session-bound `X-CSRF-Token` (the PWA handles this; other clients can get one from `GET /v1/auth/csrf`, or use a bearer session). Push uses VAPID keys in `<dataDir>/secrets/vapid.json`; keep that file across upgrades, and set `push.vapidSubject` to your contact address. Large uploads can resume over Tus at `/v1/uploads/resumable`.

## Small home instance

For a few people on one always-on machine, keep the live instance apart from any development checkout. `ops/` has what that needs:

- `ops/opencoach.service`: systemd user unit running `~/opencoach-prod/app` with `~/opencoach-prod/opencoach.env` (mode 0600; put `OPENROUTER_API_KEY` and the other variables there) and data in `~/opencoach-prod/data`. Run `loginctl enable-linger $USER` so it runs without a login session.
- `ops/deploy.sh <ref>`: fetches the ref into the production clone, takes a backup, stops, installs, builds and restarts. If the build fails, it rolls back to the previous commit. The first run needs `OPENCOACH_SOURCE=/path/to/repo`.
- `ops/backup.sh` with `ops/opencoach-backup.{service,timer}`: a nightly consistent snapshot (SQLite through the online backup API) to `~/opencoach-prod/backups`, keeping 14. Set `OPENCOACH_BACKUP_DIR` in `~/opencoach-prod/backup.env` to an external disk or a synced folder; backups hold health data and `secrets/`.

Published view versions record their directory as an absolute path, so moving a data directory needs `UPDATE ui_versions SET dir = replace(dir, '<old>/', '<new>/')` in `system.db` while the server is stopped.

**Reaching it from phones without a domain:** Tailscale Funnel publishes a node on its `*.ts.net` name over HTTPS, terminating TLS on your machine. Funnel allows ports 443, 8443 and 10000; use two of them for the two origins:

```sh
sudo tailscale set --operator=$USER   # once
tailscale funnel --bg --https=8443 http://127.0.0.1:8080
tailscale funnel --bg --https=10000 http://127.0.0.1:8081
```

Then set `PUBLIC_URL=https://<node>.ts.net:8443`, `VIEWS_URL=https://<node>.ts.net:10000` and `OPENCOACH_TRUST_PROXY=loopback`. A Cloudflare Tunnel on two subdomains of your own domain works the same way.

**Accounts:** the first account is the administrator. Invite others from Settings → Admin; each invite code works once for 24 hours. Ask everyone to add a passkey (synced by their phone's password manager). If someone loses every signed-in device, Settings → Admin → People → *Create recovery code* gives a 30-minute code they enter as the pairing code on the sign-in screen. As administrator you can read everyone's coaching transcripts through the admin tools; tell them.

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
