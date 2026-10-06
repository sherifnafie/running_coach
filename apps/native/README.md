# OpenCoach native shell (Android first)

A [Capacitor](https://capacitorjs.com) wrapper around the OpenCoach PWA (SPEC §14, Phase 2). It loads the PWA from **your** server, so coach-authored views, chat and settings work unchanged. It adds:

- **Health Connect sync** (`HealthConnectPlugin.kt`): the native bridge is intended to read workouts shared through Health Connect, including supported Samsung Health data, with your permission. Its data contract covers exercise sessions, heart-rate samples, distance, steps and calories. *Settings → Health Connect → Import workouts* appears when the bridge reports availability. It requests permission, reads the chosen period, and sends the unchanged sessions to your server (`POST /v1/sync/health`). They are stored as raw data and your coach gets a `data.synced` event (SPEC §10.5). Mocked bridge and settings tests cover this flow; Android compilation and device integration remain unverified.
- **Native push**: `@capacitor/push-notifications` is included, but native FCM registration and delivery remain scaffold work. Web Push is supported by the installed browser PWA on compatible browsers; delivery inside the Android WebView has not been verified and depends on platform support.

> Status: this is a scaffold. It was generated with `cap add android` and edited by hand, but it has **not been compiled in CI** because the build environment has no Android SDK. Check the Health Connect and Capacitor versions before your first build.

## Build

Requirements: JDK 21, Android Studio (or the Android SDK command-line tools), and a running OpenCoach server reachable from your phone over HTTPS (for example via Tailscale or Cloudflare Tunnel; see `docs/self-hosting.md`).

```bash
pnpm install
OPENCOACH_SERVER_URL=https://coach.example.ts.net pnpm --filter @opencoach/native sync
pnpm --filter @opencoach/native open     # opens Android Studio → Run
```

If you build without `OPENCOACH_SERVER_URL`, the app shows a small "connect to your coach" page. In that mode native plugins are not available to the remote page; for Health Connect, bake the URL in.

## Privacy

Health data is read on-device only after you grant permission in the Health Connect dialog. It is sent only to your own server. Nothing goes to third-party fitness APIs.

## Not implemented yet

- A share-sheet target ("share screenshot to coach" straight from Samsung Health). For now, use the upload button in chat.
- FCM native push registration on the server side.
- HealthKit (iOS).
