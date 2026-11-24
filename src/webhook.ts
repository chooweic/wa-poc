// The Meta WhatsApp webhook: `GET /webhook` (verification handshake) and
// `POST /webhook` (incoming messages).

import type { InboundMessage } from './channels/types';
import { getConfig, normalizePhone, type Env } from './env';
import { unsupportedMessageReply } from './media';
import { ingestInbound } from './pipeline';
import { timingSafeEqual, toHex } from './util';

/**
 * Meta signs every POST body with the app secret (HMAC-SHA256) and sends it
 * as `X-Hub-Signature-256: sha256=<hex>`. Checking it proves the request
 * really came from Meta and was not altered.
 */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toHex(mac), header.slice('sha256='.length).toLowerCase());
}

/**
 * Turns a webhook payload into channel-neutral messages. Status updates
 * (sent / delivered / read) carry no `messages` array and are ignored.
 */
export function parseWebhookPayload(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;
  for (const entry of payload.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      for (const m of change?.value?.messages ?? []) {
        const parsed = parseMessage(m);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseMessage(m: any): InboundMessage | null {
  if (typeof m?.id !== 'string' || typeof m?.from !== 'string') return null;
  const base = { channel: 'meta' as const, channelMessageId: m.id, from: normalizePhone(m.from) };

  if (m.type === 'text' && typeof m.text?.body === 'string') {
    return { ...base, type: 'text', text: m.text.body };
  }
  if (m.type === 'image' && typeof m.image?.id === 'string') {
    return {
      ...base,
      type: 'image',
      text: typeof m.image.caption === 'string' ? m.image.caption : '',
      media: { source: 'meta', mediaId: m.image.id, mimeType: m.image.mime_type ?? 'image/jpeg' },
    };
  }
  if (m.type === 'document' && typeof m.document?.id === 'string') {
    return {
      ...base,
      type: 'document',
      text: typeof m.document.caption === 'string' ? m.document.caption : '',
      media: {
        source: 'meta',
        mediaId: m.document.id,
        mimeType: m.document.mime_type ?? 'application/octet-stream',
        ...(typeof m.document.filename === 'string' ? { filename: m.document.filename } : {}),
      },
    };
  }
  // Audio, video, stickers, locations, contacts, reactions, buttons...
  const kind = typeof m.type === 'string' && /^[a-z_]+$/.test(m.type) ? m.type.replace(/_/g, ' ') : undefined;
  return { ...base, type: 'unsupported', text: unsupportedMessageReply(kind) };
}

/** GET /webhook: Meta calls this once when you register the webhook URL. */
export function handleWebhookVerify(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const token = url.searchParams.get('hub.verify_token') ?? '';
  if (
    env.WHATSAPP_VERIFY_TOKEN &&
    url.searchParams.get('hub.mode') === 'subscribe' &&
    timingSafeEqual(token, env.WHATSAPP_VERIFY_TOKEN)
  ) {
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/** POST /webhook: verify, queue, and answer 200 straight away. */
export async function handleWebhookPost(request: Request, env: Env): Promise<Response> {
  if (!getConfig(env).metaEnabled) return new Response('WhatsApp channel is not configured', { status: 503 });

  const rawBody = await request.text();
  const valid = await verifySignature(rawBody, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET ?? '');
  if (!valid) return new Response('Invalid signature', { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const origin = new URL(request.url).origin;
  for (const inbound of parseWebhookPayload(payload)) {
    // De-duplication and the allowlist are handled inside ingestInbound.
    // If this throws, the 500 makes Meta deliver the webhook again later.
    await ingestInbound(env, inbound, origin);
  }
  return new Response('OK', { status: 200 });
}
