-- Schema for the WhatsApp <-> Claude transactions prototype.
-- Tables prefixed `kb_` are the knowledge base, `mock_` simulate a separate
-- target system (a mini HR app); everything else is the assistant's own state.

-- ---------------------------------------------------------------- KB ------
CREATE TABLE kb_articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE kb_transaction_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,          -- generated from the name, e.g. leave_application
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',      -- free text: when it applies
  process_guide TEXT    NOT NULL DEFAULT '',      -- free text: general rules
  fields_schema TEXT    NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}', -- technical (JSON Schema)
  is_active     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE kb_reasons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id             INTEGER NOT NULL REFERENCES kb_transaction_types(id) ON DELETE CASCADE,
  code                TEXT    NOT NULL,           -- generated from the label, hidden from business users
  label               TEXT    NOT NULL,
  process_guide       TEXT    NOT NULL DEFAULT '',-- free text written by business users
  evidence_rule       TEXT    NOT NULL DEFAULT 'optional' CHECK (evidence_rule IN ('required', 'optional', 'none')),
  max_days            INTEGER,                    -- optional limit enforced in code
  extra_fields_schema TEXT,                       -- technical (JSON Schema fragment), optional
  is_active           INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (type_id, code)
);

-- ------------------------------------------------------ Conversations -----
CREATE TABLE conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel          TEXT NOT NULL CHECK (channel IN ('meta', 'mock')),
  phone_number     TEXT NOT NULL,                 -- international format, digits only
  history_reset_at TEXT,                          -- set by /reset: older messages are not sent to Claude
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_message_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, phone_number)
);

CREATE TABLE messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel_message_id TEXT,                        -- the channel's own id; used to de-duplicate inbound
  type               TEXT NOT NULL DEFAULT 'text',-- text | image | document | unsupported
  text               TEXT NOT NULL DEFAULT '',    -- body or caption
  media_ref          TEXT,                        -- JSON: media still to be downloaded (Meta only)
  evidence_id        TEXT,                        -- set once the file is stored in R2
  status             TEXT NOT NULL DEFAULT 'done',-- inbound: queued | done | failed
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at       TEXT
);
CREATE UNIQUE INDEX idx_messages_channel_id ON messages(channel_message_id) WHERE channel_message_id IS NOT NULL;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);

-- ------------------------------------------------------------ Drafts ------
CREATE TABLE drafts (
  id                   TEXT PRIMARY KEY,           -- also the reference / idempotency key sent to the target app
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  phone_number         TEXT NOT NULL,
  transaction_type_id  INTEGER NOT NULL,
  transaction_type_key TEXT NOT NULL,
  reason_code          TEXT,
  user_wording         TEXT,                       -- the user's own words for the reason (audit)
  fields               TEXT NOT NULL DEFAULT '{}', -- JSON: { name: { value, status: confirmed|unconfirmed } }
  notes                TEXT NOT NULL DEFAULT '[]', -- JSON: [{ text, at }]  (never sent to the target app)
  steps                TEXT NOT NULL DEFAULT '[]', -- JSON: [{ id, text, status, note }]
  status               TEXT NOT NULL DEFAULT 'collecting'
                         CHECK (status IN ('collecting', 'awaiting_confirmation', 'submitted', 'failed', 'cancelled')),
  target_reference     TEXT,                       -- reference number returned by the target app
  error                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- One open draft per user (conversation).
CREATE UNIQUE INDEX idx_drafts_one_open ON drafts(conversation_id)
  WHERE status IN ('collecting', 'awaiting_confirmation');
CREATE INDEX idx_drafts_updated ON drafts(updated_at);

CREATE TABLE evidence (
  id              TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  draft_id        TEXT,                            -- set by attach_evidence
  message_id      INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'document')),
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  filename        TEXT,
  summary         TEXT,                            -- what Claude read from the file (text only)
  extracted_data  TEXT,                            -- JSON: [{ name, value }]
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_evidence_conversation ON evidence(conversation_id, created_at);
CREATE INDEX idx_evidence_draft ON evidence(draft_id);

-- ------------------------------------------- WhatsApp simulator (/mock-wa) -
CREATE TABLE mock_wa_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),  -- in = user to bot
  body         TEXT NOT NULL DEFAULT '',
  evidence_id  TEXT,
  media_kind   TEXT,
  media_name   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_mock_wa_phone ON mock_wa_messages(phone_number, id);

-- ----------------------------------- Mock target application (mini HR) -----
CREATE TABLE mock_users (
  phone_number       TEXT PRIMARY KEY,             -- the user's ID in this prototype
  name               TEXT NOT NULL,
  sick_leave_balance REAL NOT NULL DEFAULT 14,
  off_day_balance    REAL NOT NULL DEFAULT 6,
  unpaid_days_taken  REAL NOT NULL DEFAULT 0
);

CREATE TABLE mock_leave_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no     TEXT NOT NULL UNIQUE,           -- the mock app's own reference number
  client_reference TEXT NOT NULL UNIQUE,           -- the caller's reference (draft id) = idempotency key
  phone_number     TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  reason_code      TEXT NOT NULL,
  reason_label     TEXT,
  user_wording     TEXT,
  start_date       TEXT,
  end_date         TEXT,
  days             REAL,
  status           TEXT NOT NULL,                  -- approved | pending_review
  details          TEXT NOT NULL DEFAULT '{}',     -- JSON: other fields, evidence, checklist
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE mock_api_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  idempotency_key TEXT,
  request_json    TEXT NOT NULL,
  response_json   TEXT NOT NULL,
  status          INTEGER NOT NULL
);
