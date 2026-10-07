# Chat composer verification — 7 October 2026

The owner asked for chat usability comparable to familiar messenger/chat apps, while keeping the feeling of talking to a coach. This change updates harness-owned browser UI and preserves voice recording duration at the upload boundary, without changing the coach, engine, runtime or training logic.

## What changed

- A rounded multiline composer with larger attachment, microphone and send targets. The field grows while typing, scrolls after reaching its height limit, shrinks when cleared, and remeasures after viewport/width changes and tab switches.
- Unsent text is saved locally under an athlete-specific key. Explicit sign-out already removes the app's local preferences/drafts. Attachments and audio previews are temporary and are not restored after reload.
- Horizontal image/file previews, size/type rejection, dismissible explanations, desktop Enter/Shift+Enter and mobile newline behavior. Existing queued sending, quick replies, uploads and coach messages retain their original paths.
- Voice notes use tap → record → stop → review → send/discard. This replaces holding through an asynchronous permission prompt, which could cancel the first recording as permission was granted. No audio is uploaded before explicit send. Microphone constructor/start failures release owned tracks; call-owned streams remain owned by the call.
- Missing transcription service, blocked permissions, missing devices and insecure HTTP get clear messages. The microphone does not start when the server reports voice notes unavailable. A GO text-model key alone does not configure speech.
- The browser supplies its Clock-derived recording duration as validated multipart metadata. The gateway uses it when transcription omits duration, instead of saving every such note as zero seconds. Provider duration takes precedence; old clients without metadata remain supported. Invalid hints are rejected before transcription.
- The shell follows the unzoomed visual viewport; the viewport meta tag requests content resizing on Android. The conversation remains pinned when composer/keyboard space changes if the reader was already at the bottom.

## Evidence

Pinned Node 22.23.3 and pnpm 10.28.0; installed Chromium on Linux. Synthetic athlete data only; no paid speech/model requests for this change.

- Web unit suite: 141 passing tests, including 14 new composer/microphone cases. Covers draft restoration/ownership, IME and newline behavior, missing service, explicit send/discard, late microphone permission cancellation, leaving Chat, denied permission recovery, recorder startup failure and stream ownership.
- Chromium browser suites: 20 passing tests (12 mock-gateway UI flows, 8 real composed-gateway flows). The real gateway tests run the actual runtime/workspace with the scripted coach and a separately configured local transcription fixture.
- Voice evidence uses Chromium's synthetic microphone, real MediaRecorder capture, successful preview playback, zero uploads before Send, then actual authenticated `/v1/voice-notes` upload. The production speech SDK issues a multipart request to the controlled `/v1/audio/transcriptions` endpoint. The gateway saves the captured blob, transcript and model in `user.voice_note`, and the browser displays the saved transcript. The fixture returns a fixed synthetic transcript, so this verifies transport and UI rather than recognition accuracy.
- Browser layout checks cover 320/390/768/1440 widths, light/dark colors, capped long drafts, width-dependent wrapping, tab return, reload, send clearing and a reduced mobile viewport. The latter simulates available keyboard space; it is not a physical keyboard/device test.
- Server suite: 27 passing tests, including 20 gateway tests. Covers duration fallback/provider precedence, legacy uploads and rejection of negative, non-finite, empty and excessive duration hints before speech processing, plus authenticated HTTP/WebSocket and server lifecycle contracts.
- Expanded tab-switch tests exposed a pre-existing deletion deadlock. Cancelled Today queries could finish their work after the browser disconnected, leaving five requests in the deletion drain because `onResponse` never ran. The sign-in screen was an effect of the in-progress deletion revoking access. Cleanup now registers response-close handling after the handler finishes, and handles responses already closed at that point. Two real HTTP cancellation controls check that unfinished queries/writes keep deletion waiting and that it completes once their work finishes. No early cleanup on request abort is used. This does not resolve the separate account-cache findings from the project review.
- Aggregate TypeScript and production build checked separately. No evaluation gates were required because seed/constitution/skills/runtime/engine were unchanged.

`docs/images/demo-chat.png` and `docs/images/chat-desktop.png` show the actual scripted demo with an unsent synthetic goal. Reproduce captures with `OPENCOACH_CAPTURE_CHAT=1 pnpm --filter @opencoach/web exec vitest run test/gateway-e2e.spec.ts`.

## Remaining limits

Paid speech-provider recognition, physical Android/iOS microphones, Safari recording formats and OS keyboard behavior remain unverified. The owner must configure STT and HTTPS to use voice notes on a phone; see [voice setup](../self-hosting.md#voice-notes). External voice-call services, native integrations, the previously recorded account-cache/restart review findings, and full coaching/model evaluation are outside this UI change.
