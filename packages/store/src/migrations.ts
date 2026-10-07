/**
 * Ordered schema migrations, applied with `PRAGMA user_version`.
 *
 * Rules: never edit a shipped migration; append a new one. Each migration runs in its own
 * transaction and bumps user_version to its 1-based position in this array.
 *
 * Column names are snake_case (ADR 0002). JSON columns hold camelCase JSON.
 */
export const MIGRATIONS: readonly string[] = [
  // ---------------------------------------------------------------------------------- v1: initial
  `
  CREATE TABLE athletes (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    created_at   TEXT NOT NULL
  );

  CREATE TABLE settings (
    athlete_id TEXT PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
    json       TEXT NOT NULL
  );

  CREATE TABLE pairing_codes (
    code        TEXT PRIMARY KEY,
    purpose     TEXT NOT NULL CHECK (purpose IN ('setup', 'link_device', 'invite')),
    athlete_id  TEXT,
    created_by  TEXT,
    is_admin    INTEGER,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT
  );
  CREATE INDEX pairing_codes_athlete_idx ON pairing_codes (athlete_id);

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    athlete_id   TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('cookie', 'bearer')),
    device_name  TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  CREATE INDEX sessions_athlete_idx ON sessions (athlete_id, created_at);

  CREATE TABLE passkeys (
    credential_id TEXT PRIMARY KEY,
    athlete_id    TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,
    device_name   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX passkeys_athlete_idx ON passkeys (athlete_id, created_at);

  -- Event log. seq is a stable rowid (FTS5 rowid == events.seq); id is the ULID-based public id.
  CREATE TABLE events (
    seq          INTEGER PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,
    athlete_id   TEXT NOT NULL,
    ts           TEXT NOT NULL,
    type         TEXT NOT NULL,
    actor        TEXT NOT NULL,
    turn_id      TEXT,
    causation_id TEXT,
    payload      TEXT NOT NULL,
    tombstoned   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_athlete_id_idx ON events (athlete_id, id);
  CREATE INDEX events_athlete_type_idx ON events (athlete_id, type, id);

  CREATE VIRTUAL TABLE events_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');

  CREATE TABLE message_state (
    message_id TEXT PRIMARY KEY,
    athlete_id TEXT NOT NULL,
    delivery   TEXT NOT NULL CHECK (delivery IN ('held', 'sent')),
    held_until TEXT,
    sent_at    TEXT,
    read_at    TEXT,
    proactive  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX message_state_athlete_idx ON message_state (athlete_id, delivery, sent_at);
  CREATE INDEX message_state_held_idx ON message_state (delivery, held_until);

  CREATE TABLE blobs (
    athlete_id TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    name       TEXT,
    origin     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    rel_path   TEXT NOT NULL,
    meta       TEXT,
    PRIMARY KEY (athlete_id, sha256)
  );
  CREATE INDEX blobs_origin_idx ON blobs (athlete_id, origin, created_at);

  CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,
    athlete_id      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    spec            TEXT NOT NULL,
    purpose         TEXT NOT NULL,
    payload         TEXT,
    during_pause    INTEGER NOT NULL DEFAULT 0,
    next_fire_at    TEXT,
    status          TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'done')),
    created_at      TEXT NOT NULL,
    created_in_turn TEXT,
    last_fired_at   TEXT
  );
  CREATE INDEX schedules_due_idx ON schedules (status, next_fire_at);
  CREATE INDEX schedules_athlete_idx ON schedules (athlete_id, status);

  CREATE TABLE epochs (
    id           TEXT PRIMARY KEY,
    athlete_id   TEXT NOT NULL,
    local_date   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    provider     TEXT NOT NULL,
    model        TEXT NOT NULL,
    opened_at    TEXT NOT NULL,
    closed_at    TEXT,
    close_reason TEXT,
    carryover    TEXT
  );
  CREATE INDEX epochs_athlete_idx ON epochs (athlete_id, opened_at);

  CREATE TABLE epoch_items (
    epoch_id   TEXT NOT NULL REFERENCES epochs(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    turn_id    TEXT,
    item       TEXT NOT NULL,
    tokens     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (epoch_id, seq)
  );

  CREATE TABLE turns (
    id                TEXT PRIMARY KEY,
    athlete_id        TEXT NOT NULL,
    epoch_id          TEXT,
    agent             TEXT NOT NULL,
    parent_turn_id    TEXT,
    task_id           TEXT,
    trigger_class     TEXT NOT NULL,
    trigger_event_ids TEXT NOT NULL,
    tier              TEXT NOT NULL,
    provider          TEXT,
    model             TEXT,
    status            TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    steps             INTEGER NOT NULL DEFAULT 0,
    usage             TEXT NOT NULL,
    cost_usd          REAL NOT NULL DEFAULT 0,
    commit_hash       TEXT,
    note              TEXT,
    error             TEXT,
    fallbacks         TEXT NOT NULL
  );
  CREATE INDEX turns_athlete_idx ON turns (athlete_id, id);

  CREATE TABLE turn_contexts (
    turn_id    TEXT PRIMARY KEY,
    athlete_id TEXT,
    context    TEXT NOT NULL
  );
  CREATE INDEX turn_contexts_athlete_idx ON turn_contexts (athlete_id);

  CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    athlete_id      TEXT NOT NULL,
    parent_turn_id  TEXT NOT NULL,
    profile         TEXT,
    task            TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'cancelled')),
    background      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    ended_at        TEXT,
    summary         TEXT,
    outputs         TEXT NOT NULL,
    cost_usd        REAL NOT NULL DEFAULT 0,
    error           TEXT,
    origin_event_id TEXT
  );
  CREATE INDEX tasks_athlete_idx ON tasks (athlete_id, created_at);

  CREATE TABLE usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id          TEXT NOT NULL,
    turn_id             TEXT,
    at                  TEXT NOT NULL,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    tier                TEXT,
    kind                TEXT NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cost_usd            REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_athlete_at_idx ON usage (athlete_id, at);
  CREATE INDEX usage_at_idx ON usage (at);

  CREATE TABLE push_subscriptions (
    id         TEXT PRIMARY KEY,
    athlete_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    keys       TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX push_subscriptions_athlete_idx ON push_subscriptions (athlete_id, endpoint);

  CREATE TABLE ui_versions (
    athlete_id   TEXT NOT NULL,
    view_id      TEXT NOT NULL,
    version      TEXT NOT NULL,
    commit_hash  TEXT NOT NULL,
    summary      TEXT NOT NULL,
    published_at TEXT NOT NULL,
    published_by TEXT NOT NULL,
    manifest     TEXT NOT NULL,
    dir          TEXT NOT NULL,
    PRIMARY KEY (athlete_id, view_id, version)
  );

  CREATE TABLE ui_current (
    athlete_id TEXT NOT NULL,
    view_id    TEXT NOT NULL,
    version    TEXT NOT NULL,
    PRIMARY KEY (athlete_id, view_id),
    FOREIGN KEY (athlete_id, view_id, version) REFERENCES ui_versions (athlete_id, view_id, version) ON DELETE CASCADE
  );

  CREATE TABLE audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id TEXT,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT
  );
  CREATE INDEX audit_athlete_idx ON audit (athlete_id, id);

  CREATE TABLE idempotency (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idempotency_expires_idx ON idempotency (expires_at);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // ---------------------------------------------------------------------- v2: provider credentials
  `
  CREATE TABLE credentials (
    athlete_id TEXT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai')),
    owner      TEXT NOT NULL CHECK (owner IN ('athlete', 'admin')),
    ciphertext TEXT NOT NULL,
    hint       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (athlete_id, provider)
  );
  `,
];
