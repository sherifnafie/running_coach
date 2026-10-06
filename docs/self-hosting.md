# Self-hosting OpenCoach

OpenCoach stores each athlete's coach workspace, raw uploads and history on your server. The app and coach-authored views use separate origins. Node 22.13 or newer, pnpm 10.28, Git and Python 3 are required. Linux with unprivileged user namespaces is the default isolated execution environment; Docker is the alternative.

## Start the demo

```sh
pnpm install --frozen-lockfile
pnpm build
OPENCOACH_DEMO=1 pnpm start
```

Open `http://localhost:8080`. Copy the setup code printed at startup (also saved with mode 0600 to `apps/server/.data/setup-code.txt` by the default start command). Accept the health-data consent, AI disclosure and age confirmation. The demo is a scripted test double, clearly labeled in its messages. It exercises chat, quick replies, scheduling and workspace writes. It provides no real model reasoning.

`pnpm start` runs with `apps/server` as its working directory. Relative configuration and data paths resolve there. For predictable paths across CLI and server commands, use absolute `OPENCOACH_CONFIG` and `OPENCOACH_DATA_DIR` paths. Create data on a private filesystem and back it up as health information.

## Use a model

Unset `OPENCOACH_DEMO` (or set it to `0`) and set one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. Restart the server. Provider SDKs run in the trusted server; keys never enter coach sandboxes. With no keys and no explicit model configuration the server selects the demo automatically. With explicit tiers, an unavailable provider fails startup.

Copy `opencoach.config.example.yaml` to an absolute configuration path and set `OPENCOACH_CONFIG` to it to choose tier models, compatible endpoints, limits, search, or MCP servers. Environment variables override YAML. `.env.example` documents supported variables; the CLI does not load dotenv automatically. Supply credentials through your process manager or shell, and exclude them from version control.

OpenAI enables voice notes, speech synthesis and realtime/cascaded calls. Compatible STT/TTS endpoints can be configured separately. These features report unavailable when their providers are absent. MCP servers are configured by the deployment administrator; their outputs are treated as untrusted content. Tools can be allowlisted, and helper access defaults off.

### OpenCode GO

Copy `opencoach.config.opencode-go.example.yaml` to an absolute configuration path, set `OPENCOACH_CONFIG` to that path, set `OPENCOACH_DEMO=0`, and supply `OPENCODE_GO_API_KEY` through your shell or process manager. The CLI does not load `.env` files automatically. The key alone does not select OpenCode GO: both the compatible provider and its tier mappings must be configured explicitly. Default provider selection remains unchanged.

The example uses **DeepSeek V4.1 Flash** (`deepseek-v4.1-flash`) for coach, deep and fast tiers at the [official GO endpoint](https://opencode.ai/docs/go/): `https://opencode.ai/zen/go/v1`. It enables `replayReasoningContent: true` for thinking/tool continuations. Requests include `User-Agent: OpenCoach/0.1.0` and a stable conversation identifier in `x-opencode-session`, using supplied epoch metadata or the athlete/cache key. Credentials stay in the trusted server. The example sets `vision: false`; this is the text model, distinct from DeepSeek V4 Flash Vision Exp. Add a separately verified vision provider before relying on screenshot extraction.

The example's `models.pricing` uses GO's peak USD-per-million-token values, checked on 6 October 2026: input $0.30, output $1.20, cache reads $0.006. GO also documents off-peak rates. OpenCoach uses these fixed peak rates for a conservative token-equivalent budget estimate; it does not read subscription allowances or the provider's billing ledger. Unknown models otherwise report zero cost, so update pricing when changing models and check current official rates.

Bounded live checks on 6 October 2026 passed authentication/model availability, streamed tools, reasoning replay, usage/cache reporting, and the real app's signup → delivered welcome/intake → saved run/plan → all four views. The requested 08:00 local check-in was persisted; future scheduled delivery was not exercised. See [the verification record](verification/opencode-go-smoke.md). This is smoke evidence, not the full [MOD-2] conformance suite or coaching-quality certification.

The supplied Compose file does not automatically pass the GO key or mount its configuration. For GO in Compose, add an override that passes `OPENCODE_GO_API_KEY` and `OPENCOACH_CONFIG: /config/go.yaml`, and bind-mount your secret-free YAML read-only at `/config/go.yaml`. Keep the key in the server environment and retain the separate app/views origins. The recorded live GO run used the host server; Docker browser verification used the scripted demo.

## Views and mobile access

The app defaults to port 8080 and isolated views to port 8081. `PUBLIC_URL` and `VIEWS_URL` must be distinct bare origins that the browser can reach. For a phone, replace both localhost URLs with the server's reachable hostnames. Use HTTPS through a reverse proxy or private tunnel for passkeys, microphone capture, PWA installation and push. Proxy WebSocket upgrades for `/v1/stream` and preserve the external app Origin.

Install Chromium and set `OPENCOACH_CHROMIUM_PATH` when automatic discovery cannot locate it. Coach publication runs static, browser, performance and accessibility gates. Missing Chromium disables preview and publication; bundled seed views remain available. Preview screenshots and view code run without general network access. Views use a restrictive CSP on their own origin and an iframe with `sandbox="allow-scripts"`.

Push keys are generated under `<dataDir>/secrets/vapid.json` (0600). Preserve this file across upgrades to keep browser subscriptions working. Set `push.vapidSubject` to your contact email. Push delivery respects notification preferences, quiet-hour holds and connected app clients.

Browser sessions use an HttpOnly session cookie. Mutations require both the public Origin and a session-bound `X-CSRF-Token`; the PWA supplies it automatically. Authenticated workers can fetch the token from `GET /v1/auth/csrf`. Bearer clients use their explicit authorization header.

Large uploads can resume through Tus 1.0.0 at `POST /v1/uploads/resumable`. Supply `Upload-Length` and optional base64 `Upload-Metadata`, then use authenticated `HEAD` and offset-checked `PATCH` requests at the returned Location. Drafts expire after one hour and are limited to 25 MiB. The final PATCH returns `Upload-Blob-Sha256`; GET returns `{blob}` for the existing `/v1/uploads/commit` flow. Image privacy processing applies before completion.

## Sandboxes

The local provider probes user, mount and network namespaces before starting. Commands see only `/workspace`, read-only `/raw`, `/history` and `/system`, read-only OS files, and private temporary storage. Git metadata is read-only. Process environments are built from an allowlist. Isolation failures stop startup unless `OPENCOACH_ALLOW_UNSAFE_SANDBOX=1` was explicitly set for development. Both Docker images include the Python analysis/parsing libraries listed in SPEC §4; local namespaces select `/opt/coach-python/bin` when that read-only environment is installed and exposed.

For Docker execution, build `docker/sandbox.Dockerfile`, set `OPENCOACH_SANDBOX=docker`, and configure the image/socket. The server must have access to the daemon. Athlete bind paths must exist at the same absolute paths from the daemon's perspective: when the server itself runs in a container, use matching host bind paths rather than a container-only `/data` path. Docker socket access gives the trusted server control of the daemon; keep it outside athlete mounts.

The example Compose deployment uses local namespaces inside the server container:

```sh
mkdir -p .data
# The server image runs as uid/gid 1000; the bind directory must be writable by that user.
docker compose up --build
```

The Compose file binds ports to loopback. It sets `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined` for the trusted server so nested user/PID namespaces can mount private procfs. Each athlete namespace still drops capabilities, mounts its own procfs, masks sensitive paths and denies networking. Hosts that disallow user namespaces need their policy configured or the Docker sandbox provider selected. The final server image built and passed non-root startup, browser demo, Python-library and sandbox virtual-time checks on 6 October 2026 (see the verification record). A managed build proxy can supply its CA with `docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -f docker/server.Dockerfile .`; TLS verification stays enabled and the CA is not stored in image layers.

## Export, import and maintenance

Settings offers export, view history/revert, calendar feed rotation and account deletion. Exports include committed workspace files, a consistent coach database, raw uploads and events; sessions and deployment secrets are excluded. Import creates an athlete without administrator privileges. To run the CLI from the repository root:

```sh
node apps/server/bin/opencoach.mjs setup-code
node apps/server/bin/opencoach.mjs export "athlete-id"
node apps/server/bin/opencoach.mjs import "/absolute/path/bundle.tar.gz" "new-athlete-id"
```

Replace the quoted example arguments with the real account ID or file path. Use the same absolute data/config paths as the running server. Stop the server before imports. A setup code can only create the first administrator; later accounts use administrator-issued invites. SIGINT/SIGTERM closes listeners, voice calls, timers, sandboxes and SQLite connections.

Run `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm eval:selftest` before an upgrade. `pnpm test:e2e` verifies the built PWA against a real demo server. Offline evaluation self-tests use seeded scripted coaches and make no model API calls. Real provider credentials and an explicit eval CLI choice are required for paid model runs.
