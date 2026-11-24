// Conversations and their messages (the chat log the assistant keeps).

import type { ChannelName, InboundMessage } from './channels/types';

export interface Conversation {
  id: number;
  channel: ChannelName;
  phone_number: string;
  history_reset_at: string | null;
  created_at: string;
  last_message_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  direction: 'in' | 'out';
  channel_message_id: string | null;
  type: string;
  text: string;
  media_ref: string | null;
  evidence_id: string | null;
  status: string;
  created_at: string;
  processed_at: string | null;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export async function getOrCreateConversation(
  db: D1Database,
  channel: ChannelName,
  phoneNumber: string,
): Promise<Conversation> {
  await db
    .prepare('INSERT OR IGNORE INTO conversations (channel, phone_number) VALUES (?, ?)')
    .bind(channel, phoneNumber)
    .run();
  const row = await db
    .prepare('SELECT * FROM conversations WHERE channel = ? AND phone_number = ?')
    .bind(channel, phoneNumber)
    .first<Conversation>();
  if (!row) throw new Error('conversation could not be created');
  return row;
}

export async function getConversation(db: D1Database, id: number): Promise<Conversation | null> {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<Conversation>();
}

export async function getMessage(db: D1Database, id: number): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>();
}

/**
 * Stores an inbound message as `queued`. Returns null when a message with the
 * same channel id was already stored (a duplicate delivery), so the caller
 * can skip it.
 */
export async function insertInbound(
  db: D1Database,
  conversationId: number,
  msg: InboundMessage,
): Promise<number | null> {
  const mediaRef = msg.media?.source === 'meta' ? JSON.stringify(msg.media) : null;
  const evidenceId = msg.media?.source === 'stored' ? msg.media.evidenceId : null;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO messages (conversation_id, direction, channel_message_id, type, text, media_ref, evidence_id, status)
       VALUES (?, 'in', ?, ?, ?, ?, ?, 'queued')`,
    )
    .bind(conversationId, msg.channelMessageId, msg.type, msg.text, mediaRef, evidenceId)
    .run();
  if (!result.meta.changes) return null;
  await db.prepare(`UPDATE conversations SET last_message_at = ${NOW} WHERE id = ?`).bind(conversationId).run();
  return result.meta.last_row_id;
}

export async function insertOutbound(db: D1Database, conversationId: number, text: string): Promise<void> {
  await db
    .prepare(`INSERT INTO messages (conversation_id, direction, type, text, status) VALUES (?, 'out', 'text', ?, 'done')`)
    .bind(conversationId, text)
    .run();
  await db.prepare(`UPDATE conversations SET last_message_at = ${NOW} WHERE id = ?`).bind(conversationId).run();
}

export async function setMessageStatus(db: D1Database, id: number, status: 'done' | 'failed'): Promise<void> {
  await db.prepare(`UPDATE messages SET status = ?, processed_at = ${NOW} WHERE id = ?`).bind(status, id).run();
}

export async function setMessageEvidence(db: D1Database, id: number, evidenceId: string): Promise<void> {
  await db.prepare('UPDATE messages SET evidence_id = ?, media_ref = NULL WHERE id = ?').bind(evidenceId, id).run();
}

/**
 * The most recent messages before `beforeMessageId`, oldest first. Messages
 * from before the last /reset are left out.
 */
export async function recentHistory(
  db: D1Database,
  conversation: Conversation,
  beforeMessageId: number,
  limit: number,
): Promise<MessageRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ?1 AND id < ?2 AND (?3 IS NULL OR created_at > ?3)
       ORDER BY id DESC LIMIT ?4`,
    )
    .bind(conversation.id, beforeMessageId, conversation.history_reset_at, limit)
    .all<MessageRow>();
  return rows.results.reverse();
}

export async function resetHistory(db: D1Database, conversationId: number): Promise<void> {
  await db.prepare(`UPDATE conversations SET history_reset_at = ${NOW} WHERE id = ?`).bind(conversationId).run();
}

/** True while any inbound message of this conversation is still being processed (drives "typing…"). */
export async function hasQueuedMessages(db: D1Database, conversationId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM messages WHERE conversation_id = ? AND direction = 'in' AND status = 'queued' LIMIT 1`)
    .bind(conversationId)
    .first();
  return Boolean(row);
}

export async function listConversations(db: D1Database): Promise<(Conversation & { message_count: number })[]> {
  const rows = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c ORDER BY c.last_message_at DESC LIMIT 100`,
    )
    .all<Conversation & { message_count: number }>();
  return rows.results;
}

export async function listMessages(db: D1Database, conversationId: number, limit = 300): Promise<MessageRow[]> {
  const rows = await db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .bind(conversationId, limit)
    .all<MessageRow>();
  return rows.results.reverse();
}
