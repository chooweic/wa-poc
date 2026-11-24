// Routes for the WhatsApp simulator (/mock-wa). The page itself is in
// mock-wa.html; this file is the small JSON API it talks to.

import { recordMockUserMessage } from '../channels/mockwa';
import type { InboundMessage } from '../channels/types';
import { getOrCreateConversation, hasQueuedMessages } from '../conversations-repo';
import { getConfig, normalizePhone, type Env } from '../env';
import { baseMimeType, mediaRejection, storeEvidence } from '../media';
import { ensureMockSeed } from '../mock-app/seed';
import { ingestInbound } from '../pipeline';
import { htmlResponse, json } from '../util';
import page from './mock-wa.html';

export async function handleMockWa(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/mock-wa' && request.method === 'GET') return htmlResponse(page);

  if (path === '/mock-wa/api/users' && request.method === 'GET') {
    await ensureMockSeed(env);
    const users = await env.DB.prepare('SELECT phone_number, name FROM mock_users ORDER BY name').all();
    return json({ users: users.results });
  }

  if (path === '/mock-wa/api/messages' && request.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') ?? '');
    const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
    if (!phone) return json({ messages: [], typing: false });
    const rows = await env.DB.prepare(
      'SELECT id, direction, body, evidence_id, media_kind, media_name, created_at FROM mock_wa_messages WHERE phone_number = ? AND id > ? ORDER BY id LIMIT 200',
    )
      .bind(phone, after)
      .all();
    const conversation = await env.DB.prepare(`SELECT id FROM conversations WHERE channel = 'mock' AND phone_number = ?`)
      .bind(phone)
      .first<{ id: number }>();
    const typing = conversation ? await hasQueuedMessages(env.DB, conversation.id) : false;
    return json({ messages: rows.results, typing });
  }

  if (path === '/mock-wa/api/send' && request.method === 'POST') return sendFromSimulator(request, env, url);

  return new Response('Not found', { status: 404 });
}

/**
 * The simulator's equivalent of the Meta webhook: turn what the page posted
 * into an InboundMessage and hand it to the same pipeline.
 */
async function sendFromSimulator(request: Request, env: Env, url: URL): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: 'Expected form data.' }, 400);

  const phone = normalizePhone(String(form.get('phone') ?? ''));
  if (phone.length < 6 || phone.length > 15) return json({ error: 'Enter a phone number of 6 to 15 digits.' }, 400);
  const text = String(form.get('text') ?? '').slice(0, 4096);
  const upload = form.get('file');
  const file = upload instanceof File && upload.size > 0 ? upload : null;
  if (!text.trim() && !file) return json({ error: 'Nothing to send.' }, 400);

  const base = { channel: 'mock' as const, channelMessageId: `mock-${crypto.randomUUID()}`, from: phone };
  let inbound: InboundMessage;

  if (!file) {
    await recordMockUserMessage(env.DB, { phone, body: text });
    inbound = { ...base, type: 'text', text };
  } else {
    const mime = baseMimeType(file.type);
    const kind = mime === 'application/pdf' ? 'document' : 'image';
    const rejection = mediaRejection(mime, file.size, getConfig(env).maxUploadBytes);
    if (rejection) {
      // Not stored. The pipeline replies with the same friendly message a real user would get.
      await recordMockUserMessage(env.DB, { phone, body: text, mediaKind: 'document', mediaName: file.name });
      inbound = { ...base, type: 'unsupported', text: rejection };
    } else {
      // No Meta download step: the file goes straight to R2.
      const conversation = await getOrCreateConversation(env.DB, 'mock', phone);
      const evidence = await storeEvidence(env.DB, env.EVIDENCE, {
        conversationId: conversation.id,
        messageId: null,
        bytes: await file.arrayBuffer(),
        mimeType: mime,
        filename: file.name,
      });
      await recordMockUserMessage(env.DB, { phone, body: text, evidenceId: evidence.id, mediaKind: kind, mediaName: file.name });
      inbound = { ...base, type: kind, text, media: { source: 'stored', evidenceId: evidence.id } };
    }
  }

  const result = await ingestInbound(env, inbound, url.origin);
  return json({ ok: true, result });
}
