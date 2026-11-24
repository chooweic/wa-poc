// The two channels must feed the orchestrator identically: everything after
// the channel boundary is shared.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { splitText } from '../src/channels/types';
import { getConversation, getMessage } from '../src/conversations-repo';
import { seedMockData } from '../src/mock-app/seed';
import { buildTurnInput } from '../src/pipeline';
import { createDeps, createTestEnv, META_SECRETS, metaEnvelope, PNG_BYTES, say, ScriptedClaude, sendViaSimulator, sendViaWebhook } from './helpers';

const PHONE = '6590000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Stands in for Meta's Graph API: records what was sent and serves one media file. */
function stubGraphApi() {
  const sent: any[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/PHONE_ID/messages')) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true });
    }
    if (url.endsWith('/MEDIA1')) return Response.json({ url: 'https://lookaside.test/file', mime_type: 'image/png', file_size: PNG_BYTES.byteLength });
    if (url === 'https://lookaside.test/file') return new Response(PNG_BYTES);
    throw new Error(`unexpected fetch: ${url}`);
  });
  return sent;
}

/** The orchestrator input with the parts that legitimately differ (ids, channel, timestamps) removed. */
async function normalisedInput(env: any) {
  const row = await env.DB.prepare(`SELECT id FROM messages WHERE direction = 'in' ORDER BY id DESC`).first();
  const message = (await getMessage(env.DB, row.id))!;
  const conversation = (await getConversation(env.DB, message.conversation_id))!;
  const input = await buildTurnInput(env.DB, conversation, message, 'https://app.test');
  return {
    phone: input.conversation.phone_number,
    type: input.message.type,
    text: input.message.text,
    direction: input.message.direction,
    hasEvidenceId: Boolean(input.message.evidence_id),
    mediaRef: input.message.media_ref,
    evidence: input.evidence && {
      kind: input.evidence.kind,
      mime_type: input.evidence.mime_type,
      size_bytes: input.evidence.size_bytes,
      sha256: input.evidence.sha256,
      linkedToMessage: input.evidence.message_id === input.message.id,
    },
    baseUrl: input.baseUrl,
  };
}

async function viaSimulator(text: string, withImage: boolean) {
  const env = createTestEnv();
  await seedMockData(env);
  const claude = new ScriptedClaude([say('ok'), say('ok')]);
  const file = withImage ? { bytes: PNG_BYTES, type: 'image/png', name: 'mc.png' } : undefined;
  const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, text, file);
  return { input: await normalisedInput(env), request: claude.requests[0], replies, env };
}

async function viaWebhook(message: Record<string, unknown>) {
  const env = createTestEnv({ ...META_SECRETS, ALLOWED_WHATSAPP_NUMBERS: PHONE });
  await seedMockData(env);
  const sent = stubGraphApi();
  const claude = new ScriptedClaude([say('ok'), say('ok')]);
  const status = await sendViaWebhook(env, createDeps(env, claude), metaEnvelope({ from: PHONE, ...message }));
  return { input: await normalisedInput(env), request: claude.requests[0], sent, status, env };
}

const comparable = (request: unknown) => JSON.stringify(request).replace(UUID, '<id>');

afterEach(() => vi.unstubAllGlobals());

describe('a /mock-wa message and a Meta webhook message produce the same orchestrator input', () => {
  test('text message', async () => {
    const mock = await viaSimulator('I was sick yesterday', false);
    const meta = await viaWebhook({ id: 'wamid.t1', type: 'text', text: { body: 'I was sick yesterday' } });
    expect(meta.status).toBe(200);
    expect(meta.input).toEqual(mock.input);
    expect(comparable(meta.request)).toBe(comparable(mock.request)); // Claude is sent exactly the same thing
    expect(mock.env.DB).not.toBe(meta.env.DB);
  });

  test('image with a caption', async () => {
    const mock = await viaSimulator('my MC', true);
    const meta = await viaWebhook({ id: 'wamid.i1', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'my MC' } });
    expect(meta.input).toEqual(mock.input);
    expect(meta.input.evidence).toMatchObject({ kind: 'image', mime_type: 'image/png', size_bytes: 12, linkedToMessage: true });
    expect(comparable(meta.request)).toBe(comparable(mock.request));
    expect(comparable(meta.request)).toContain('"type":"image"');
    // The Meta file was downloaded and copied into R2.
    expect((meta.env.EVIDENCE as any).store.size).toBe(1);
  });

  test('conversations record which channel they came from', async () => {
    const mock = await viaSimulator('hi', false);
    const meta = await viaWebhook({ id: 'wamid.t2', type: 'text', text: { body: 'hi' } });
    const channel = async (env: any) => (await env.DB.prepare('SELECT channel FROM conversations').first()).channel;
    expect(await channel(mock.env)).toBe('mock');
    expect(await channel(meta.env)).toBe('meta');
  });
});

describe('the real channel', () => {
  test('marks the message read with a typing indicator, then replies through the Graph API', async () => {
    const { sent } = await viaWebhook({ id: 'wamid.t3', type: 'text', text: { body: 'hello' } });
    expect(sent[0]).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.t3', typing_indicator: { type: 'text' } });
    expect(sent[1]).toMatchObject({ messaging_product: 'whatsapp', to: PHONE, type: 'text', text: { body: 'ok' } });
  });

  test('an unsupported message kind gets a friendly reply without calling Claude', async () => {
    const { sent, request } = await viaWebhook({ id: 'wamid.a1', type: 'audio', audio: { id: 'A1' } });
    expect(request).toBeUndefined();
    expect(sent.at(-1).text.body).toMatch(/can't handle audio messages yet/);
  });

  test('an oversized file is rejected before it is downloaded', async () => {
    const env = createTestEnv({ ...META_SECRETS, ALLOWED_WHATSAPP_NUMBERS: PHONE, MAX_UPLOAD_MB: '1' });
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/messages')) return sent.push(JSON.parse(String(init?.body))), Response.json({});
      if (url.endsWith('/BIG')) return Response.json({ url: 'https://lookaside.test/big', mime_type: 'application/pdf', file_size: '9000000' });
      throw new Error(`should not download: ${url}`);
    });
    await sendViaWebhook(env, createDeps(env, new ScriptedClaude([])), metaEnvelope({ id: 'wamid.d1', from: PHONE, type: 'document', document: { id: 'BIG', mime_type: 'application/pdf' } }));
    expect(sent.at(-1).text.body).toMatch(/too large \(the limit is 1 MB\)/);
    expect((env.EVIDENCE as any).store.size).toBe(0);
  });
});

describe('outbound text', () => {
  test('long replies are split at 4096 characters, preferring paragraph breaks', () => {
    expect(splitText('short')).toEqual(['short']);
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(700)).join('\n\n');
    const chunks = splitText(paragraphs);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join('\n\n')).toBe(paragraphs);
    expect(splitText('y'.repeat(9000)).map((c) => c.length)).toEqual([4096, 4096, 808]);
  });
});
