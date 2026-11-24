// The Telegram webhook: `POST /telegram/webhook`.
//
// Telegram does not tell a bot the user's phone number, and the app uses the
// phone number as the user's ID. So before anything else, each user shares
// their number once with Telegram's "share my phone number" button. Until
// then, every message gets that button; nothing reaches the agent.
//
// Short replies that need no thinking (the share-number prompt, greetings,
// refusals) are sent in the webhook response itself, which Telegram allows.
// Real messages are queued like every other channel's.

import type { InboundMessage } from './channels/types';
import { getConfig, normalizePhone, type Env } from './env';
import { unsupportedMessageReply } from './media';
import { ingestInbound } from './pipeline';
import { resolveSender } from './sender';
import { getTelegramLink, linkTelegramPhone, rememberTelegramChat } from './telegram-links';
import { sha256Hex, timingSafeEqual } from './util';

/**
 * The secret Telegram sends back in `X-Telegram-Bot-Api-Secret-Token` with
 * every update. Taken from TELEGRAM_WEBHOOK_SECRET if set, otherwise derived
 * from the bot token, so there is one less setting to manage.
 */
export async function telegramWebhookSecret(env: Env): Promise<string> {
  const explicit = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;
  const data = new TextEncoder().encode(`wa-poc telegram webhook:${env.TELEGRAM_BOT_TOKEN ?? ''}`);
  return (await sha256Hex(data.buffer as ArrayBuffer)).slice(0, 64);
}

const SHARE_BUTTON = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const REMOVE_KEYBOARD = { remove_keyboard: true };

export const SHARE_PROMPT =
  "Hi! I'm the Attendance Business Agent. Before we start, please share your phone number with the button below. It's how I know who you are; I only need it once.";
const WRONG_CONTACT = 'Please share your own number, using the button below.';
const LINKED = "Thanks, you're all set. How can I help? For example, you can say “I was sick yesterday”.";
const NOT_REGISTERED = "Thanks. This number isn't set up to use the assistant. Please ask your administrator to add it.";
const GREETING = "Hi! I'm the Attendance Business Agent. Tell me what you need, for example “I was sick yesterday”.";

type TelegramMessage = Record<string, any>;

/** A reply sent in the webhook response (no separate API call). */
function replyNow(chatId: string, text: string, replyMarkup?: unknown): Response {
  return Response.json({ method: 'sendMessage', chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

const ok = (): Response => new Response('OK', { status: 200 });

const UNSUPPORTED_KINDS: [field: string, label: string][] = [
  ['voice', 'voice'],
  ['audio', 'audio'],
  ['video', 'video'],
  ['video_note', 'video'],
  ['animation', 'GIF'],
  ['sticker', 'sticker'],
  ['location', 'location'],
  ['venue', 'location'],
  ['poll', 'poll'],
];

/** Turns a Telegram message into a channel-neutral one, for a user whose phone number is known. */
export function parseTelegramMessage(msg: TelegramMessage, phone: string): InboundMessage {
  const chatId = String(msg.chat.id);
  const base = {
    channel: 'telegram' as const,
    channelMessageId: `tg-${chatId}-${msg.message_id}`,
    from: normalizePhone(phone),
    // Replies go to this chat.
    receivedOn: chatId,
  };
  const text: string = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';

  if (Array.isArray(msg.photo) && msg.photo.length) {
    // Telegram sends several sizes, smallest first; the largest is last. Photos are always JPEG.
    const largest = msg.photo[msg.photo.length - 1];
    return { ...base, type: 'image', text, media: { source: 'telegram', fileId: String(largest.file_id), mimeType: 'image/jpeg' } };
  }
  if (msg.document?.file_id) {
    const mimeType = String(msg.document.mime_type ?? 'application/octet-stream').toLowerCase();
    return {
      ...base,
      type: mimeType.startsWith('image/') ? 'image' : 'document',
      text,
      media: {
        source: 'telegram',
        fileId: String(msg.document.file_id),
        mimeType,
        ...(typeof msg.document.file_name === 'string' ? { filename: msg.document.file_name } : {}),
      },
    };
  }
  const kind = UNSUPPORTED_KINDS.find(([field]) => msg[field] !== undefined);
  if (kind) return { ...base, type: 'unsupported', text: unsupportedMessageReply(kind[1]) };
  if (text) return { ...base, type: 'text', text };
  return { ...base, type: 'unsupported', text: unsupportedMessageReply() };
}

/** POST /telegram/webhook */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const config = getConfig(env);
  if (!config.telegramEnabled) return new Response('Telegram channel is not configured', { status: 503 });

  const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(secret, await telegramWebhookSecret(env))) return new Response('Invalid secret', { status: 401 });

  const update = (await request.json().catch(() => null)) as Record<string, any> | null;
  if (!update) return new Response('Bad request', { status: 400 });

  // Only new messages in one-to-one chats; edits, group chats and everything else are ignored.
  const msg: TelegramMessage | undefined = update.message;
  if (!msg || msg.chat?.type !== 'private' || !msg.from?.id || msg.from.is_bot) return ok();
  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);

  // The user shared a contact: accept it only if it is their own number.
  if (msg.contact) {
    if (String(msg.contact.user_id ?? '') !== userId || !msg.contact.phone_number) return replyNow(chatId, WRONG_CONTACT, SHARE_BUTTON);
    const phone = normalizePhone(String(msg.contact.phone_number));
    await linkTelegramPhone(env.DB, userId, chatId, phone);
    const decision = resolveSender(config, 'telegram', phone);
    console.log(JSON.stringify({ evt: 'telegram_linked', allowed: decision.allowed, reason: decision.reason ?? null }));
    return replyNow(chatId, decision.allowed ? LINKED : NOT_REGISTERED, REMOVE_KEYBOARD);
  }

  const link = await getTelegramLink(env.DB, userId);
  if (!link?.phone_number) {
    await rememberTelegramChat(env.DB, userId, chatId);
    return replyNow(chatId, SHARE_PROMPT, SHARE_BUTTON);
  }
  if (link.chat_id !== chatId) await rememberTelegramChat(env.DB, userId, chatId);

  const decision = resolveSender(config, 'telegram', link.phone_number);
  if (!decision.allowed) {
    console.log(JSON.stringify({ evt: 'sender_rejected', channel: 'telegram', reason: decision.reason }));
    return replyNow(chatId, NOT_REGISTERED);
  }

  if (typeof msg.text === 'string' && /^\/start(\s|@|$)/.test(msg.text.trim())) return replyNow(chatId, GREETING, REMOVE_KEYBOARD);

  // De-duplication happens inside ingestInbound (Telegram resends an update until it gets a 200).
  await ingestInbound(env, parseTelegramMessage(msg, link.phone_number), new URL(request.url).origin);
  return ok();
}
