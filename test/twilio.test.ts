// WhatsApp through Twilio: signature, parsing, the webhook, and that it feeds
// the same pipeline as the other channels.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { getConversation, getMessage } from '../src/conversations-repo';
import { seedMockData } from '../src/mock-app/seed';
import { buildTurnInput } from '../src/pipeline';
import { toWhatsAppAddress } from '../src/twilio-client';
import { computeTwilioSignature, parseTwilioMessage, verifyTwilioSignature } from '../src/twilio-webhook';
import {
  createDeps,
  createTestEnv,
  PNG_BYTES,
  say,
  ScriptedClaude,
  sendViaSimulator,
  sendViaTwilio,
  TWILIO_SETTINGS,
  twilioFields,
} from './helpers';

const PHONE = '6590000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

afterEach(() => vi.unstubAllGlobals());

/** Stands in for Twilio's APIs: records messages sent and typing calls, and serves one media file. */
function stubTwilio() {
  const calls: { url: string; auth: string | null; form: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url === 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM1/Media/ME1') {
      if (!auth) return new Response('auth required', { status: 401 });
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
    }
    if (url.startsWith('https://api.twilio.com/') || url.startsWith('https://messaging.twilio.com/')) {
      calls.push({ url, auth, form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      return Response.json({ sid: 'SMout', success: true }, { status: 201 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

function twilioEnv(extra: Record<string, string> = {}) {
  return createTestEnv({ ...TWILIO_SETTINGS, ALLOWED_WHATSAPP_NUMBERS: PHONE, ...extra });
}

describe('Twilio signature', () => {
  test("matches Twilio's documented example", async () => {
    // From Twilio's webhook security documentation.
    const params: [string, string][] = [
      ['CallSid', 'CA1234567890ABCDE'],
      ['Caller', '+12349013030'],
      ['Digits', '1234'],
      ['From', '+12349013030'],
      ['To', '+18005551212'],
    ];
    expect(await computeTwilioSignature('https://mycompany.com/myapp.php?foo=1&bar=2', params, '12345')).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  test('rejects a wrong token, a changed field, a different URL and a missing header', async () => {
    const params: [string, string][] = [['Body', 'hi'], ['From', 'whatsapp:+6590000001']];
    const good = await computeTwilioSignature('https://app.test/twilio/webhook', params, 'tok');
    expect(await verifyTwilioSignature('https://app.test/twilio/webhook', params, good, 'tok')).toBe(true);
    expect(await verifyTwilioSignature('https://app.test/twilio/webhook', params, good, 'other')).toBe(false);
    expect(await verifyTwilioSignature('https://app.test/twilio/webhook', [['Body', 'YES'], params[1]], good, 'tok')).toBe(false);
    expect(await verifyTwilioSignature('https://app.test/twilio/webhook/', params, good, 'tok')).toBe(false);
    expect(await verifyTwilioSignature('https://app.test/twilio/webhook', params, null, 'tok')).toBe(false);
  });
});

describe('Twilio message parsing', () => {
  const parse = (f: Record<string, string>) => parseTwilioMessage(new URLSearchParams(twilioFields(f)));

  test('text', () => {
    expect(parse({ MessageSid: 'SM1', Body: 'I was sick yesterday' })).toEqual({
      channel: 'twilio', channelMessageId: 'SM1', from: PHONE, type: 'text', text: 'I was sick yesterday',
    });
  });
  test('image with caption, and a PDF', () => {
    expect(parse({ MessageSid: 'MM1', Body: 'my MC', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/x', MediaContentType0: 'image/jpeg' })).toMatchObject({
      type: 'image', text: 'my MC', media: { source: 'twilio', url: 'https://api.twilio.com/x', mimeType: 'image/jpeg' },
    });
    expect(parse({ MessageSid: 'MM2', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/y', MediaContentType0: 'application/pdf' })).toMatchObject({
      type: 'document', text: '',
    });
  });
  test('voice notes and empty messages get a friendly reply instead', () => {
    expect(parse({ MessageSid: 'MM3', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/z', MediaContentType0: 'audio/ogg' })).toMatchObject({
      type: 'unsupported', text: expect.stringMatching(/can't handle voice or audio messages/),
    });
    expect(parse({ MessageSid: 'SM4', Body: '', Latitude: '1.3', Longitude: '103.8' })?.type).toBe('unsupported');
  });
  test('status callbacks and SMS are ignored', () => {
    expect(parse({ MessageSid: 'SM5', MessageStatus: 'delivered' })).toBeNull();
    expect(parse({ MessageSid: 'SM6', Body: 'hi', From: '+6590000001' })).toBeNull();
  });
  test('addresses are normalised both ways', () => {
    expect(toWhatsAppAddress('+65 9000 0001')).toBe('whatsapp:+6590000001');
    expect(toWhatsAppAddress('whatsapp:+14155238886')).toBe('whatsapp:+14155238886');
  });
});

describe('Twilio webhook', () => {
  test('is off (503) until the TWILIO_* settings are set', async () => {
    const env = createTestEnv();
    const res = await sendViaTwilio(env, createDeps(env, null), twilioFields({ MessageSid: 'SM1', Body: 'hi' }));
    expect(res.status).toBe(503);
  });

  test('a bad signature is refused and nothing is queued', async () => {
    const env = twilioEnv();
    const res = await sendViaTwilio(env, createDeps(env, null), twilioFields({ MessageSid: 'SM1', Body: 'hi' }), 'bad');
    expect(res.status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<any>()).n).toBe(0);
  });

  test('replies with empty TwiML, then answers through the Twilio API with a typing indicator first', async () => {
    const env = twilioEnv();
    await seedMockData(env);
    const calls = stubTwilio();
    const res = await sendViaTwilio(env, createDeps(env, new ScriptedClaude([say('Hello from the agent')])), twilioFields({ MessageSid: 'SM9', Body: 'hi' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/xml/);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    expect(calls[0]).toMatchObject({ url: 'https://messaging.twilio.com/v2/Indicators/Typing.json', form: { messageId: 'SM9', channel: 'whatsapp' } });
    expect(calls[1]).toMatchObject({
      url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SETTINGS.TWILIO_ACCOUNT_SID}/Messages.json`,
      form: { From: 'whatsapp:+14155238886', To: 'whatsapp:+6590000001', Body: 'Hello from the agent' },
    });
    const expectedAuth = `Basic ${btoa(`${TWILIO_SETTINGS.TWILIO_ACCOUNT_SID}:${TWILIO_SETTINGS.TWILIO_AUTH_TOKEN}`)}`;
    expect(calls[1].auth).toBe(expectedAuth);
    expect((await env.DB.prepare('SELECT channel FROM conversations').first<any>()).channel).toBe('twilio');
  });

  test('a repeated delivery is processed once', async () => {
    const env = twilioEnv();
    stubTwilio();
    const claude = new ScriptedClaude([say('one')]);
    await sendViaTwilio(env, createDeps(env, claude), twilioFields({ MessageSid: 'SM7', Body: 'hi' }));
    await sendViaTwilio(env, createDeps(env, claude), twilioFields({ MessageSid: 'SM7', Body: 'hi' }));
    expect(claude.requests).toHaveLength(1);
  });

  test('numbers not in ALLOWED_WHATSAPP_NUMBERS are ignored', async () => {
    const env = twilioEnv();
    const calls = stubTwilio();
    const res = await sendViaTwilio(env, createDeps(env, null), twilioFields({ MessageSid: 'SM8', Body: 'hi', From: 'whatsapp:+6599999999' }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test('long replies are split at 1,600 characters', async () => {
    const env = twilioEnv();
    const calls = stubTwilio();
    const long = Array.from({ length: 5 }, (_, i) => `Part ${i} ` + 'x'.repeat(700)).join('\n\n');
    await sendViaTwilio(env, createDeps(env, new ScriptedClaude([say(long)])), twilioFields({ MessageSid: 'SM10', Body: 'hi' }));
    const sent = calls.filter((c) => c.url.endsWith('/Messages.json')).map((c) => c.form.Body);
    expect(sent.length).toBeGreaterThan(1);
    for (const body of sent) expect(body.length).toBeLessThanOrEqual(1600);
  });

  test('an unsupported file type is turned down without being downloaded', async () => {
    const env = twilioEnv();
    const calls = stubTwilio();
    await sendViaTwilio(
      env,
      createDeps(env, new ScriptedClaude([])),
      twilioFields({ MessageSid: 'MM5', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM5/Media/ME5', MediaContentType0: 'image/gif' }),
    );
    expect(calls.at(-1)?.form.Body).toMatch(/can't read that kind of file/);
    expect((env.EVIDENCE as any).store.size).toBe(0);
  });
});

describe('the same orchestrator input as the other channels', () => {
  async function normalised(env: any) {
    const row = await env.DB.prepare(`SELECT id FROM messages WHERE direction = 'in' ORDER BY id DESC`).first();
    const message = (await getMessage(env.DB, row.id))!;
    const conversation = (await getConversation(env.DB, message.conversation_id))!;
    const input = await buildTurnInput(env.DB, conversation, message, 'https://app.test');
    return {
      phone: input.conversation.phone_number,
      type: input.message.type,
      text: input.message.text,
      evidence: input.evidence && { kind: input.evidence.kind, mime: input.evidence.mime_type, sha256: input.evidence.sha256, size: input.evidence.size_bytes },
    };
  }

  test('an image with a caption via Twilio and via Mock WhatsApp give Claude the same request', async () => {
    const mockEnv = createTestEnv();
    await seedMockData(mockEnv);
    const mockClaude = new ScriptedClaude([say('ok'), say('ok')]);
    await sendViaSimulator(mockEnv, createDeps(mockEnv, mockClaude), PHONE, 'my MC', { bytes: PNG_BYTES, type: 'image/png', name: 'mc.png' });

    const env = twilioEnv();
    await seedMockData(env);
    stubTwilio();
    const claude = new ScriptedClaude([say('ok'), say('ok')]);
    await sendViaTwilio(
      env,
      createDeps(env, claude),
      twilioFields({ MessageSid: 'MM1', Body: 'my MC', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM1/Media/ME1', MediaContentType0: 'image/png' }),
    );

    expect(await normalised(env)).toEqual(await normalised(mockEnv));
    const comparable = (r: unknown) => JSON.stringify(r).replace(UUID, '<id>');
    expect(comparable(claude.requests[0])).toBe(comparable(mockClaude.requests[0]));
    expect((env.EVIDENCE as any).store.size).toBe(1);
  });
});
