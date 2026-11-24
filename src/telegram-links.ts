// Which phone number a Telegram account belongs to.
//
// Telegram never tells a bot the user's phone number, but the whole app uses
// the phone number as the user's ID. So each user shares it once, with
// Telegram's "share my phone number" button; Telegram then sends the number
// together with the id of the account it belongs to, and it is stored here.

import { normalizePhone } from './env';

export interface TelegramLink {
  user_id: string;
  chat_id: string;
  phone_number: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export async function getTelegramLink(db: D1Database, userId: string): Promise<TelegramLink | null> {
  return db.prepare('SELECT * FROM telegram_links WHERE user_id = ?').bind(userId).first<TelegramLink>();
}

/** Records (or refreshes) the private chat of a Telegram user, keeping any phone number already linked. */
export async function rememberTelegramChat(db: D1Database, userId: string, chatId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_links (user_id, chat_id) VALUES (?1, ?2)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = ?2, updated_at = ${NOW}`,
    )
    .bind(userId, chatId)
    .run();
}

export async function linkTelegramPhone(db: D1Database, userId: string, chatId: string, phone: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_links (user_id, chat_id, phone_number) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = ?2, phone_number = ?3, updated_at = ${NOW}`,
    )
    .bind(userId, chatId, normalizePhone(phone))
    .run();
}

/** The chat to reply to for a phone number (the most recently linked account). */
export async function chatIdForPhone(db: D1Database, phone: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT chat_id FROM telegram_links WHERE phone_number = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(normalizePhone(phone))
    .first<{ chat_id: string }>();
  return row?.chat_id ?? null;
}

export async function listTelegramLinks(db: D1Database): Promise<TelegramLink[]> {
  return (await db.prepare('SELECT * FROM telegram_links ORDER BY updated_at DESC LIMIT 200').all<TelegramLink>()).results;
}

export async function unlinkTelegram(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM telegram_links WHERE user_id = ?').bind(userId).run();
}
