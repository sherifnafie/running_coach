# ADR 0012: Fresh held outreach and durable athlete inputs

Status: accepted, 2026-10-08. Requirements: [RT-3], [RT-4], [MSG-4].

## Context

A multi-part proactive reply was split by the minimum-gap policy. Its second
message was delivered two hours later, after the athlete had answered its
questions. Release checked notification policy but not whether the draft's
context was still current. Separately, input persisted in the event log could
disappear from the coach's context when a restart interrupted debounce or
in-turn steering. The durable log was not a durable work queue.

## Decision

Keep notification limits. Treat held proactive messages as drafts tied to the
conversation at creation. Persist reply-requiring athlete input and cancel held
outreach in one SQLite transaction. Reject proactive sends with pending inputs,
closing the race before steering is drained. At release, atomically recheck
still-held state and newer conversation, view-write/revert, call-ended,
message-deletion or synced-data events using `events.seq`. Read receipts and
device telemetry do not invalidate drafts. Original held events stay immutable;
`cancelled` exists only in the private delivery projection, without a sent event,
push, unread count or proactive delivery budget charge. Terminal states cannot be
resurrected by a concurrent postponement.

The durable input queue references original athlete events, not synthetic
prompts. Replies commit their event, delivery projection and acknowledgement of
consumed input IDs together. `no_reply` explicitly acknowledges those IDs.
Inputs arriving later remain pending. Recovery screens/requeues unanswered
inputs before background follow-ups; retry wakes also reuse pending inputs as
reactive turns. Stopping a mind discards its volatile queue only. A second
restart does not replay acknowledged inputs. Account reset/delete and message
tombstoning remove corresponding pending input.

Migration 4 preserves delivery/read projections and seeds only the legacy
unanswered tail after the latest sent nonproactive reply. Historical answered
conversations are not replayed on upgrade. Migration cannot infer past
`no_reply` decisions; its narrow backfill is a one-time recovery approximation.

## Consequences

New athlete input conservatively discards queued outreach; the coach can decide
what is still relevant from the current conversation. No model call is needed
to classify individual questions as stale, and no coaching logic moves into
code. An internal notice explains discarded drafts without notifying or waking
the athlete. The durable inbox guarantees unanswered-input recovery, not
exactly-once arbitrary tool side effects after a crash. Reactive replies still
bypass proactive timing limits; quiet hours, pause and budget policy remain
unchanged for valid proactive delivery.
