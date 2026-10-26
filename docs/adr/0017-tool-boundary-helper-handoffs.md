# ADR 0017: Apply ready helper handoffs between tool batches

- Status: accepted (2026-10-26).
- Requirements: [SUB-1], [SUB-3], [SUB-5], [RT-1].
- Problem: a background helper could finish its model work while the head coach held the athlete mind's lock.
  Copy-back waited for that whole turn to end, so `task_status` kept returning `running`. The coach could spend
  further model steps checking results whose delivery its own turn was blocking.
- Decision: the mind queues ready workspace handoffs with a single-execution guard. The head turn drains them
  between completed tool batches, before its next model request. If there is no active turn, the same action
  runs under the ordinary mind lock. The queued idle-lock fallback is harmless after a boundary applied it.
  The engine awaits the existing optional `beforeStep` hook; synchronous callers remain supported.
- Guarantees: scoped worktrees, sandbox shutdown, file-grant checks and serialized workspace writes are retained.
  A task becomes `done` and emits `task.completed` only after copy-back succeeds. Incomplete/error handling
  continues through the existing helper path. The follow-up event and originating-athlete attribution remain.
  A handoff applied during a turn also appends its task event as ordinary input data, so the model sees the
  changed workspace and result before continuing. Helper text is not promoted into a system instruction.
- Scope: handoffs into the head workspace; nested helper worktrees retain their existing lifecycle. No new
  coaching workflow, polling prohibition, forced turn ending or nominal time limit is introduced.
- Verification: a scripted runtime regression holds the parent turn open while a helper finishes, verifies that
  its files stay isolated during the in-flight model call, then checks `done` and readable output at the next
  boundary. A newer parent edit survives the queued fallback, and completion is emitted once. Engine tests
  verify the async hook is awaited. No paid coaching-quality evaluation is implied by these mechanism tests.
