# Appendix C: Contracts (events, tools, micro-UI, views, gateway API)

These are **v0 contracts**. The canonical source will be Zod schemas in `packages/protocol`, from which JSON Schema (for tool definitions) and TS types are generated. Shapes are written below as TypeScript for readability. Field names are normative; descriptions are guidance. Any change after Phase 1 is a versioned protocol change.

Common types:

```ts
type ISODateTime = string;      // RFC 3339 with offset, e.g. "2026-10-07T06:58:12+02:00"
type IANATimeZone = string;     // e.g. "Europe/Amsterdam"
type EventId = string;          // ULID, time-sortable
type BlobRef = { sha256: string; mime: string; bytes: number; name?: string };
type WorkspacePath = string;    // relative to /workspace, or absolute under /raw, /history, /system
type Tier = "coach" | "deep" | "fast";
```

---

## C.1 Events

Every event has an envelope:

```ts
interface EventEnvelope<T extends string, P> {
  id: EventId;
  athlete_id: string;
  ts: ISODateTime;              // from the injectable Clock
  type: T;
  actor: "athlete" | "coach" | "helper" | "harness" | "device";
  turn_id?: string;             // set for coach/helper-originated events
  causation_id?: EventId;       // event that caused this one (e.g. message → reply)
  payload: P;
}
```

### Inbound (start or steer turns)

| type | payload | Starts turn? |
|---|---|---|
| `user.message` | `{ text: string; attachments?: BlobRef[]; reply_to?: EventId; channel: "app" \| "telegram" \| "whatsapp" \| "email" }` | Reactive |
| `user.upload` | `{ blobs: BlobRef[]; caption?: string }` | Reactive (batched with adjacent messages) |
| `user.voice_note` | `{ blob: BlobRef; duration_s: number; transcript: string; transcript_model: string }` | Reactive |
| `user.ui_action` | `{ source: { message_id?: EventId; view_id?: string }; action: string; payload: unknown; wake: boolean }` | If `wake` |
| `user.ui_write` | `{ view_id: string; target: string; op: "insert" \| "update" \| "delete"; row: Record<string, unknown>; key?: unknown }` | No (seen next turn) |
| `user.reaction` | `{ message_id: EventId; reaction: "up" \| "down" \| string }` | No |
| `user.read` | `{ message_ids: EventId[] }` | No |
| `user.settings_changed` | `{ diff: Record<string, { from: unknown; to: unknown }> }` | Follow-up if coach-relevant (tz, quiet hours, pause) |
| `user.message_deleted` | `{ message_id: EventId }` (content tombstoned) | No |
| `device.context` | `{ tz: IANATimeZone; locale: string; coarse_location?: { city?: string; country?: string } }` | No (shows in situation report; a tz change triggers follow-up) |
| `call.started` | `{ call_id: string; provider: string; model: string }` | No |
| `call.ended` | `{ call_id: string; duration_s: number; transcript: WorkspacePath; notes: WorkspacePath; ended_by: "athlete" \| "coach" \| "error" }` | Follow-up |
| `schedule.fired` | `{ schedule_id: string; purpose: string; payload?: unknown; scheduled_for: ISODateTime; created_at: ISODateTime }` | Scheduled |
| `system.heartbeat` | `{}` | Scheduled |
| `system.consolidate` | `{ epoch: string }` | Consolidation |
| `task.completed` / `task.failed` | `{ task_id: string; profile?: string; summary: string; outputs: WorkspacePath[]; error?: string; origin_event?: EventId }` | Follow-up |
| `ui.error` | `{ view_id: string; version: string; message: string; stack?: string; device: { ua: string; viewport: string } }` | Follow-up (rate-limited: max 1 per view per hour) |
| `workspace.external_change` | `{ commits: string[]; files_changed: number; summary: string }` | Follow-up |
| `harness.upgraded` | `{ from: string; to: string; changelog: WorkspacePath }` | Follow-up |
| `data.synced` (Phase 2) | `{ source: "health_connect" \| "healthkit"; blobs: BlobRef[]; range: [ISODateTime, ISODateTime] }` | Follow-up (debounced) |

### Outbound and trace

| type | payload |
|---|---|
| `coach.message` | `{ message_id: EventId; text: string; attachments: Attachment[]; ui?: MicroUI; voice_note?: BlobRef; notify: "none" \| "silent" \| "normal"; delivery: "sent" \| "held" \| "rejected"; held_until?: ISODateTime; proactive: boolean }` |
| `coach.ui_published` | `{ view_id: string; version: string; commit: string; summary: string }` |
| `coach.schedule_changed` | `{ schedule_id: string; op: "create" \| "update" \| "cancel"; spec: ScheduleSpec }` |
| `coach.turn` | `{ turn_id; trigger_class; trigger_events: EventId[]; model; tier; steps; tokens: { input; cached; output }; cost_usd; duration_ms; commit?: string; fallbacks: string[]; note: string /* private final text */ }` |
| `harness.notice` | `{ kind: "budget_warning" \| "budget_exhausted" \| "held_quiet_hours" \| "delivery_failed" \| "safety_flag" \| "fallback_used"; detail: unknown }` |

---

## C.2 Tools (main coach)

All tools return `{ ok: true, ... }` or `{ ok: false, error: { code, message, retryable } }`. Error messages are written for the model: they say what happened and what it can do next.

### Workspace

```ts
read({ path: WorkspacePath, offset?: number, limit?: number })
  // Text → content with line numbers. Images (png/jpg/webp/heic) → image content block (downscaled).
  // PDFs → text + page images (first N pages). Max 2 MB text per call.
write({ path: WorkspacePath, content: string })            // creates dirs; /raw,/history,/system → EACCES
edit({ path: WorkspacePath, old: string, new: string, replace_all?: boolean })
glob({ pattern: string, path?: WorkspacePath })
grep({ pattern: string, path?: WorkspacePath, glob?: string, context?: number, max?: number })
bash({ command: string, timeout_s?: number /* ≤ 300 */, cwd?: WorkspacePath })
  // Runs in the athlete's sandbox; no secrets; no egress except allowlisted package mirror (if enabled).
  // Output truncated to 30k chars (head+tail) with a note.
```

### Messaging

```ts
send_message({
  text: string,                         // markdown subset: bold, italic, lists, links, inline code
  attachments?: Array<
    | { kind: "blob"; sha256: string }
    | { kind: "file"; path: WorkspacePath }          // images render inline; others as file cards
    | { kind: "view_card"; view_id: string; params?: Record<string, string> }
  >,
  ui?: MicroUI,                         // see C.3
  voice_note?: boolean,                 // also deliver as TTS audio in the coach's voice
  notify?: "none" | "silent" | "normal",// default: "normal" for proactive, "silent" for replies while app is open
  reply_to?: EventId,
  during_pause?: boolean                // only honored if purpose is safety/return-date related (audited)
}) → { ok: true, message_id, delivery: "sent" | "held", held_until? }
   | { ok: false, error: { code: "PROACTIVE_BUDGET_EXHAUSTED" | "MIN_GAP" | "PAUSED" | "QUIET_HOURS_HOLD_TOO_LONG" | ... } }

no_reply({ reason: string })            // reactive turns only; satisfies [RT-4]
```

**Policy evaluation order** in `send_message`: (1) idempotency check, (2) reactive or proactive classification (proactive = the turn class isn't reactive, *and* there's no athlete-requested `origin_event`), (3) pause, (4) proactive budget and minimum gap, (5) quiet hours (hold), (6) deliver and push.

### Scheduling

```ts
type ScheduleSpec =
  | { at: ISODateTime }                                     // one-shot
  | { rrule: string; time: "HH:MM"; tz?: IANATimeZone; until?: ISODateTime }; // recurring, athlete tz default

schedule({ id?: string /* upsert key */, spec: ScheduleSpec, purpose: string, payload?: unknown,
           during_pause?: boolean })
  → { ok: true, schedule_id, next_fire_at }
list_schedules() → { schedules: Array<{ id; spec; purpose; next_fire_at; created_at; created_in_turn }> }
cancel_schedule({ id: string })
set_heartbeat({ time: "HH:MM" } | { enabled: false })     // athlete can override in settings
```

Constraints: ≤ 50 active schedules; minimum interval 15 min; `purpose` ≤ 1,000 chars; fires go through the injectable `Clock`.

### Helpers

```ts
spawn_agent({
  task: string,
  profile?: string,                    // file in /workspace/agents/<profile>.md
  tier?: Tier,                         // overrides profile
  inputs?: WorkspacePath[],            // listed in the helper's prompt; helper may read others (read-only)
  write_scope?: WorkspacePath[],       // globs; default none (read-only helper)
  tools?: string[],                    // subset of: read, glob, grep, bash, write, edit, web_search, web_fetch, preview_ui
  background?: boolean,                // default false (blocks until done or timeout)
  budget_usd?: number
}) → foreground: { ok: true, summary, outputs: WorkspacePath[], cost_usd }
   | background: { ok: true, task_id }
task_status({ task_id }) → { state: "running" | "done" | "failed" | "cancelled"; summary?; outputs? }
cancel_task({ task_id })
```

Helpers never get `send_message`, `schedule`, `spawn_agent` (beyond depth 2), or `publish_ui`.

### UI

```ts
preview_ui({ views?: string[] /* default: all changed */ })
  → { ok, report: Array<{ view_id; static_errors: string[]; runtime_errors: string[]; csp_violations: string[];
                          a11y: { critical: number; serious: number; details: string[] };
                          perf: { first_render_ms: number; bundle_kb: number };
                          screenshots: Array<{ variant: "phone-light" | "phone-dark" | "tablet-light" | "empty-state";
                                               image: ImageContent }> }> }
publish_ui({ views?: string[], summary: string })    // runs preview; refuses if gates fail; atomic swap
  → { ok: true, published: Array<{ view_id; version }> } | { ok: false, report }
rollback_ui({ view_id: string, to_version?: string }) // default previous
```

### Research and history

```ts
web_search({ query: string, max_results?: number })   // results wrapped as untrusted content
web_fetch({ url: string, prompt?: string })           // URL must come from conversation/search/workspace
search_history({ query: string, from?: ISODateTime, to?: ISODateTime,
                 types?: string[], limit?: number })   // FTS5 over event log → excerpts with event ids
```

### Voice-session toolset (realtime front-end only)

```ts
lookup({ query: string })          // runtime-executed read-only grep/SQL over workspace; ≤ 2 s budget
consult_coach({ question: string, context?: string }) // async; main coach (low/medium effort) answers; result streamed back
note({ text: string })             // append to call notes file
end_call({ reason?: string })
```

---

## C.3 Micro-UI schema

```ts
interface MicroUI {
  quick_replies?: Array<{ label: string /* ≤ 24 chars */; value: string }>;   // ≤ 6
  form?: {
    id: string;
    title?: string;
    fields: Array<
      | { id: string; type: "scale"; label: string; min: number; max: number; step?: number;
          anchors?: Record<number, string> }                                  // e.g. RPE 1–10
      | { id: string; type: "choice" | "multi_choice"; label: string; options: Array<{ label: string; value: string }> }
      | { id: string; type: "number"; label: string; unit?: string; min?: number; max?: number }
      | { id: string; type: "text"; label: string; multiline?: boolean; max_len?: number }
      | { id: string; type: "date" | "time"; label: string }
      | { id: string; type: "body_map"; label: string; multi?: boolean }        // returns region ids + optional 0–10 severity
    >;
    submit_label?: string;
  };
  notification_actions?: Array<{ label: string /* ≤ 16 chars */; value: string }>; // ≤ 3; best effort per platform
  expires_at?: ISODateTime;   // after this, chips render disabled
}
```

Responses → `user.ui_action { source: { message_id }, action: "quick_reply" | "form_submit" | "notification_action", payload: { value } | { form_id, values } , wake: true }`.

---

## C.4 Views: manifest and bridge

### `ui/app.json`

```json
{
  "version": 1,
  "nav": ["today", "calendar", "plan", "progress"],
  "home": "today",
  "theme": { "accent": "#E4572E" }
}
```

The shell always adds Chat and Settings. If `nav` has more than 5 entries, the overflow goes into a "More" menu.

### `ui/views/<id>/view.json`

```ts
interface ViewManifest {
  id: string;                              // [a-z0-9-]{1,32}
  title: string;
  icon: string;                            // name from UI-kit icon set
  placement: { nav?: number } | { home_card?: number } | { hidden: true }; // hidden = reachable via navigate/card only
  entry: string;                           // e.g. "index.html"
  kit: string;                             // UI-kit major version, e.g. "1"
  reads: string[];                         // "db:<table>" | "file:<glob>"
  writes?: Array<{ db: string; ops: Array<"insert" | "update" | "delete">; columns?: string[] }
               | { file: string; ops: Array<"write"> }>;   // file writes limited to /workspace/athlete-input/**
  actions?: string[];                      // names the view may emit via coach.act
  params?: Record<string, "string" | "date" | "number">;  // for navigate/view_card
  refresh?: "on-change" | "manual";
  card?: { entry: string; height: "s" | "m" | "l" };      // optional compact rendering for chat/home
}
```

### Bridge API (`window.coach`, injected by the UI kit; JSON-RPC 2.0 over postMessage, modeled on MCP Apps)

```ts
coach.db.query(sql: string, params?: unknown[]): Promise<Row[]>
  // read-only connection; tables restricted to manifest.reads; 5,000-row cap; 2 s timeout
coach.db.write(target: string, op: "insert" | "update" | "delete", row: object, key?: object): Promise<void>
  // must match manifest.writes; validated against current schema; queued offline; emits user.ui_write
coach.files.read(path: string): Promise<string>          // must match a "file:" read glob
coach.act(name: string, payload?: unknown, opts?: { wake?: boolean }): Promise<void>  // emits user.ui_action
coach.navigate(view_id: string, params?: Record<string, string>): void
coach.openChat(opts?: { prefill?: string; ref?: { view_id: string; params?: object } }): void
coach.subscribe(targets: string[], cb: () => void): Unsubscribe   // fires on workspace change to targets
coach.env: { theme: "light" | "dark"; locale: string; units: "metric" | "imperial"; tz: string;
             now(): Date /* injectable clock */; safeArea: Insets; viewport: { w: number; h: number }; online: boolean }
coach.toast(text: string): void
coach.report(level: "error" | "warn" | "info", message: string, detail?: unknown): void  // also auto-captures window.onerror
```

### Isolation requirements

- Served from a dedicated origin (`views.<host>`), never the gateway origin. iframe `sandbox="allow-scripts"` with **no** `allow-same-origin`, `allow-top-navigation` or `allow-popups`.
- CSP: `default-src 'none'; script-src 'self' <kit-origin>; style-src 'self' 'unsafe-inline' <kit-origin>; img-src 'self' data: blob: <kit-origin>; font-src <kit-origin>; connect-src 'none'; frame-ancestors <app-origin>`.
- The bridge validates every message against the schema and the manifest. Unknown methods are rejected and reported.

---

## C.5 Gateway API

Auth: session cookie (web) or bearer token (native), obtained via passkey or a magic link. Self-host single-user setups can use device pairing codes. All routes are scoped to the authenticated athlete. Admin routes are separate.

### WebSocket `GET /v1/stream`

Server → client messages (modeled on AG-UI event vocabulary):

```ts
| { t: "presence"; state: "idle" | "thinking" | "working" | "typing" }
| { t: "progress"; turn_id; label: string }                       // "Looking at your splits…"
| { t: "message.start"; message_id; reply_to? }
| { t: "message.delta"; message_id; text_delta: string }
| { t: "message.end"; message: CoachMessage }                     // full, authoritative
| { t: "ui.published"; view_id; version; summary }
| { t: "notice"; kind; detail }                                    // held message, budget, safety banner
| { t: "event"; event: EventEnvelope }                             // catch-all for sync
```

Client → server: `{ t: "typing" }`, `{ t: "ack"; up_to: EventId }`, `{ t: "resume"; after: EventId }` (lossless resume after reconnect).

The server MUST check `Origin` against the app origin and require the auth token in the first frame (`[SEC-4]`).

### HTTP

| Method & path | Purpose |
|---|---|
| `POST /v1/messages` | `{ text, attachments?: sha256[], reply_to?, client_id }` (`client_id` makes retries idempotent) |
| `POST /v1/uploads` | Multipart or resumable (tus) upload → `BlobRef`; images are EXIF-GPS-stripped in the coach-visible copy unless the setting is off |
| `POST /v1/voice-notes` | Audio upload → transcription → `user.voice_note` |
| `GET /v1/events?before=&after=&limit=` | Paginated history (athlete-visible event types only) |
| `POST /v1/ui-actions` · `POST /v1/ui-writes` | From micro-UI, the bridge, or notification actions |
| `GET /v1/app` | `app.json` plus view manifests with published versions |
| `POST /v1/views/:id/revert` | Athlete revert (emits an event to the coach) |
| `GET /v1/changes?before=` | Coach's changes feed (commit summaries) |
| `POST /v1/calls` | Create a call: returns `{ call_id, provider, webrtc: { sdp_endpoint, ephemeral_token, ice_servers } }`; the runtime opens the sideband |
| `POST /v1/calls/:id/end` | End the call |
| `GET /v1/exports/calendar.ics?token=` | ICS feed (secret, revocable token) |
| `GET /v1/settings` · `PUT /v1/settings` | Quiet hours, budgets, pause, notification prefs, voice, units, model and keys (self-host), consents |
| `POST /v1/push/subscriptions` | Register Web Push, FCM or APNs |
| `POST /v1/export` → `GET /v1/export/:job` | Full export bundle |
| `DELETE /v1/account` | Hard delete (`[SEC-6]`) |

### Admin (self-host owner or hosted operator)

`GET /admin/turns/:id` (trace) · `POST /admin/turns/:id/replay { model?, constitution_version? }` · `GET /admin/costs` · `GET /admin/athletes` · `POST /admin/athletes/:id/epoch` (force a new epoch).

---

## C.6 Core runtime interfaces (for adapters)

```ts
interface Clock { now(): Date; sleepUntil(t: Date, signal: AbortSignal): Promise<void> }

interface ModelProvider {
  id: string;
  capabilities(model: string): { tools: boolean; vision: boolean; maxContext: number; streamingToolInput: boolean;
                                  promptCaching: boolean; nativeCompaction: boolean; midConversationSystem: boolean;
                                  batch: boolean; reasoningEffort: string[] };
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  batch?(reqs: ModelRequest[]): Promise<BatchHandle>;
}

interface AgentLoop {
  runTurn(input: { context: AssembledContext; tools: ToolRegistry; limits: TurnLimits;
                   steering: AsyncIterable<SteeringMessage>; clock: Clock }, signal: AbortSignal)
    : AsyncIterable<TurnEvent>;   // tool calls, deltas, progress notes, final note, usage
}

interface SandboxProvider {
  ensure(athleteId: string): Promise<SandboxHandle>;      // creates or wakes
  exec(h: SandboxHandle, cmd: string, opts: { timeoutS: number; cwd: string; env?: Record<string, string> })
    : Promise<{ stdout: string; stderr: string; code: number }>;
  fs(h: SandboxHandle): SandboxFS;                         // read/write within mounts
  hibernate?(h: SandboxHandle): Promise<void>;
}

interface VoiceProvider {
  createSession(briefing: string, tools: VoiceTool[], voice: VoiceConfig): Promise<{ callId: string; client: WebRTCParams }>;
  attachSideband(callId: string): AsyncIterable<VoiceEvent>;  // tool calls, transcripts, end
  respondTool(callId: string, toolCallId: string, result: unknown): Promise<void>;
}

interface PushProvider { send(device: Device, n: { title: string; body: string; actions?: Action[]; data: object }): Promise<void> }
interface BlobStore { put(stream, meta): Promise<BlobRef>; get(sha256): Promise<Readable>; delete(sha256): Promise<void> }
```

Each interface ships with a **contract test suite** in `packages/protocol/contract-tests`, and every adapter must pass it.
