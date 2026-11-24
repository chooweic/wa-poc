// The Twilio webhook for WhatsApp: `POST /twilio/webhook`.
// Configure it in the Twilio console as the URL called "when a message comes in".

import type { InboundMessage } from './channels/types';
import { getConfig, normalizePhone, type Env } from './env';
import { unsupportedMessageReply } from './media';
import { ingestInbound } from './pipeline';
import { timingSafeEqual } from './util';

/**
 * Twilio signs each webhook: HMAC-SHA1, keyed with the auth token, over the
 * exact URL it called followed by every POST field name and value, sorted by
 * name. The base64 result is sent as `X-Twilio-Signature`.
 */
export async function computeTwilioSignature(url: string, params: [string, string][], authToken: string): Promise<string> {
  const sorted = [...params].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const data = url + sorted.map(([k, v]) => k + v).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function verifyTwilioSignature(
  url: string,
  params: [string, string][],
  header: string | null,
  authToken: string,
): Promise<boolean> {
  if (!header || !authToken) return false;
  return timingSafeEqual(await computeTwilioSignature(url, params, authToken), header);
}

/**
 * Turns Twilio's form fields into a channel-neutral message. Returns null for
 * anything that is not an incoming WhatsApp message (status callbacks, SMS).
 */
export function parseTwilioMessage(fields: URLSearchParams): InboundMessage | null {
  const sid = fields.get('MessageSid') ?? fields.get('SmsMessageSid');
  const from = fields.get('From') ?? '';
  if (!sid || fields.has('MessageStatus') || !from.toLowerCase().startsWith('whatsapp:')) return null;

  const base = { channel: 'twilio' as const, channelMessageId: sid, from: normalizePhone(from) };
  const text = fields.get('Body') ?? '';
  const mediaCount = Number.parseInt(fields.get('NumMedia') ?? '0', 10) || 0;

  if (mediaCount > 0) {
    // WhatsApp delivers at most one file per message.
    const url = fields.get('MediaUrl0') ?? '';
    const mimeType = (fields.get('MediaContentType0') ?? 'application/octet-stream').toLowerCase();
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      return { ...base, type: 'unsupported', text: unsupportedMessageReply(mimeType.startsWith('audio/') ? 'voice or audio' : 'video') };
    }
    if (!url) return { ...base, type: 'unsupported', text: unsupportedMessageReply() };
    // The type is checked properly (JPEG, PNG or PDF only) when the file is downloaded.
    return { ...base, type: mimeType.startsWith('image/') ? 'image' : 'document', text, media: { source: 'twilio', url, mimeType } };
  }
  if (text) return { ...base, type: 'text', text };
  // Locations, contacts, stickers without media, and so on.
  return { ...base, type: 'unsupported', text: unsupportedMessageReply() };
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** POST /twilio/webhook: verify, queue, and answer straight away with an empty TwiML reply. */
export async function handleTwilioWebhook(request: Request, env: Env): Promise<Response> {
  if (!getConfig(env).twilioEnabled) return new Response('Twilio channel is not configured', { status: 503 });

  const fields = new URLSearchParams(await request.text());
  // Twilio signs the exact URL it was configured with, which is the URL this request arrived on.
  const valid = await verifyTwilioSignature(
    request.url,
    [...fields.entries()],
    request.headers.get('x-twilio-signature'),
    env.TWILIO_AUTH_TOKEN ?? '',
  );
  if (!valid) return new Response('Invalid signature', { status: 403 });

  const inbound = parseTwilioMessage(fields);
  // De-duplication and the allowlist are handled inside ingestInbound.
  if (inbound) await ingestInbound(env, inbound, new URL(request.url).origin);
  return new Response(EMPTY_TWIML, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}
