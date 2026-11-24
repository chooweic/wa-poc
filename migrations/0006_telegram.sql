-- Telegram as a fourth channel.
--
-- 1. Drop the fixed list of channel names from `conversations` so that a new
--    channel never needs a table rebuild again (the code checks the names).
--    SQLite cannot change a CHECK constraint in place, so the table is rebuilt
--    the same way as in 0004: every row and id is kept, and nothing is dropped
--    while still referenced (which would cascade-delete child rows).
-- 2. Add `telegram_links`: Telegram does not tell a bot the user's phone
--    number, so each user shares it once with Telegram's "share my phone
--    number" button, and this table remembers which phone number a Telegram
--    account belongs to.

-- ---------------------------------------------------------------- 1 -------
PRAGMA defer_foreign_keys = true;

-- 1 ---------------------------------------------------------------------
CREATE TABLE conversations_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel          TEXT NOT NULL,                 -- meta | twilio | telegram | mock (checked in code)
  phone_number     TEXT NOT NULL,                 -- international format, digits only
  history_reset_at TEXT,                          -- set by /reset: older messages are not sent to Claude
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_message_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, phone_number)
);
INSERT INTO conversations_new (id, channel, phone_number, history_reset_at, created_at, last_message_at)
  SELECT id, channel, phone_number, history_reset_at, created_at, last_message_at FROM conversations;

-- 2 ---------------------------------------------------------------------
CREATE TABLE messages_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel_message_id TEXT,                        -- the channel's own id; used to de-duplicate inbound
  type               TEXT NOT NULL DEFAULT 'text',-- text | image | document | unsupported
  text               TEXT NOT NULL DEFAULT '',    -- body or caption
  media_ref          TEXT,                        -- JSON: media still to be downloaded (Meta, Twilio or Telegram)
  evidence_id        TEXT,                        -- set once the file is stored in R2
  received_on        TEXT,                        -- inbound: the address the user wrote to (reply from / to it)
  status             TEXT NOT NULL DEFAULT 'done',-- inbound: queued | done | failed
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at       TEXT
);
INSERT INTO messages_new (id, conversation_id, direction, channel_message_id, type, text, media_ref, evidence_id, received_on, status, created_at, processed_at)
  SELECT id, conversation_id, direction, channel_message_id, type, text, media_ref, evidence_id, received_on, status, created_at, processed_at FROM messages;

CREATE TABLE drafts_new (
  id                   TEXT PRIMARY KEY,           -- also the reference / idempotency key sent to the target app
  conversation_id      INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
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
INSERT INTO drafts_new (id, conversation_id, phone_number, transaction_type_id, transaction_type_key, reason_code, user_wording,
                        fields, notes, steps, status, target_reference, error, created_at, updated_at)
  SELECT id, conversation_id, phone_number, transaction_type_id, transaction_type_key, reason_code, user_wording,
         fields, notes, steps, status, target_reference, error, created_at, updated_at FROM drafts;

CREATE TABLE evidence_new (
  id              TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
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
INSERT INTO evidence_new (id, conversation_id, draft_id, message_id, kind, mime_type, size_bytes, sha256, r2_key, filename, summary, extracted_data, created_at)
  SELECT id, conversation_id, draft_id, message_id, kind, mime_type, size_bytes, sha256, r2_key, filename, summary, extracted_data, created_at FROM evidence;

-- 3 ---------------------------------------------------------------------
DROP TABLE messages;
DROP TABLE drafts;
DROP TABLE evidence;
DROP TABLE conversations;

-- 4 ---------------------------------------------------------------------
ALTER TABLE conversations_new RENAME TO conversations;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE drafts_new RENAME TO drafts;
ALTER TABLE evidence_new RENAME TO evidence;

-- 5 ---------------------------------------------------------------------
CREATE UNIQUE INDEX idx_messages_channel_id ON messages(channel_message_id) WHERE channel_message_id IS NOT NULL;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE UNIQUE INDEX idx_drafts_one_open ON drafts(conversation_id)
  WHERE status IN ('collecting', 'awaiting_confirmation');
CREATE INDEX idx_drafts_updated ON drafts(updated_at);
CREATE INDEX idx_evidence_conversation ON evidence(conversation_id, created_at);
CREATE INDEX idx_evidence_draft ON evidence(draft_id);

-- ---------------------------------------------------------------- 2 -------
CREATE TABLE telegram_links (
  user_id      TEXT PRIMARY KEY,                  -- Telegram user id
  chat_id      TEXT NOT NULL,                     -- the private chat with the bot (where replies go)
  phone_number TEXT,                              -- digits only; NULL until the user shares it
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_telegram_links_phone ON telegram_links(phone_number);
