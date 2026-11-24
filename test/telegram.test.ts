// Telegram: the share-your-phone-number step, the webhook, the channel, and
// that it feeds the same pipeline as the other channels.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { seedMockData } from '../src/mock-app/seed';
import { toTelegramHtml } from '../src/telegram-client';
import { getTelegramLink } from '../src/telegram-links';
import { parseTelegramMessage, SHARE_PROMPT } from '../src/telegram-webhook';
import { handleAdmin } from '../src/ui/admin';
import {
  createDeps,
  createTestEnv,
  PNG_BYTES,
  say,
  ScriptedClaude,
  sendViaSimulator,
  sendViaTelegram,
  TELEGRAM_SETTINGS,
  telegramUpdate,
} from './helpers';

const PHONE = '6590000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

afterEach(() => vi.unstubAllGlobals());

/** Stands in for the Telegram Bot API: records calls and serves one photo. */
function stubTelegram(options: { rejectHtml?: boolean } = {}) {
  const calls: { method: string; params: Record<string, any> }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.telegram.org/file/bot123456:TEST-token/photos/file_1.jpg') {
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/jpeg' } });
    }
    const match = url.match(/^https:\/\/api\.telegram\.org\/bot123456:TEST-token\/(\w+)$/);
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    const params = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method: match[1], params });
    if (match[1] === 'sendMessage' && options.rejectHtml && params.parse_mode === 'HTML') {
      return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
    }
    if (match[1] === 'getFile') return Response.json({ ok: true, result: { file_id: params.file_id, file_size: 12, file_path: 'photos/file_1.jpg' } });
    if (match[1] === 'getMe') return Response.json({ ok: true, result: { username: 'wa_poc_bot' } });
    if (match[1] === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '', pending_update_count: 0 } });
    return Response.json({ ok: true, result: true });
  });
  return calls;
}

function telegramEnv(extra: Record<string, string> = {}) {
  return createTestEnv({ ...TELEGRAM_SETTINGS, ALLOWED_WHATSAPP_NUMBERS: PHONE, ...extra });
}

const contact = (phone: string, userId = 777) => ({ contact: { phone_number: phone, user_id: userId, first_name: 'Test' } });
const queuedCount = async (env: any) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n;

async function linkedEnv() {
  const env = telegramEnv();
  await seedMockData(env);
  await sendViaTelegram(env, createDeps(env, null), telegramUpdate(contact('+65 9000 0001')));
  return env;
}

describe('the webhook secret', () => {
  test('is off (503) without TELEGRAM_BOT_TOKEN', async () => {
    const env = createTestEnv();
    expect((await sendViaTelegram(env, createDeps(env, null), telegramUpdate({ text: 'hi' }), 'x')).status).toBe(503);
  });
  test('a wrong or missing secret is refused', async () => {
    const env = telegramEnv();
    expect((await sendViaTelegram(env, createDeps(env, null), telegramUpdate({ text: 'hi' }), 'wrong')).status).toBe(401);
    expect(await queuedCount(env)).toBe(0);
  });
});

describe('sharing the phone number', () => {
  test('an unknown user gets the share-number button and nothing reaches the agent', async () => {
    const env = telegramEnv();
    const claude = new ScriptedClaude([]);
    const res = await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ text: 'I was sick yesterday' }));
    expect(await res.json()).toEqual({
      method: 'sendMessage',
      chat_id: '777',
      text: SHARE_PROMPT,
      reply_markup: { keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    expect(claude.requests).toHaveLength(0);
    expect(await queuedCount(env)).toBe(0);
  });

  test('sharing your own number links it', async () => {
    const env = telegramEnv();
    const res = await sendViaTelegram(env, createDeps(env, null), telegramUpdate(contact('+65 9000 0001')));
    expect(await res.json()).toMatchObject({ chat_id: '777', text: expect.stringMatching(/you're all set/), reply_markup: { remove_keyboard: true } });
    expect(await getTelegramLink(env.DB, '777')).toMatchObject({ chat_id: '777', phone_number: PHONE });
  });

  test("someone else's contact card is refused", async () => {
    const env = telegramEnv();
    const res = await sendViaTelegram(env, createDeps(env, null), telegramUpdate(contact('6599999999', 888)));
    expect(await res.json()).toMatchObject({ text: 'Please share your own number, using the button below.' });
    expect((await getTelegramLink(env.DB, '777'))?.phone_number ?? null).toBeNull();
  });

  test('a number not in ALLOWED_WHATSAPP_NUMBERS is linked but told politely it is not set up', async () => {
    const env = telegramEnv();
    const res = await sendViaTelegram(env, createDeps(env, null), telegramUpdate(contact('6591112222')));
    expect(await res.json()).toMatchObject({ text: expect.stringMatching(/isn't set up to use the assistant/) });
    const claude = new ScriptedClaude([]);
    const next = await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ text: 'hi' }));
    expect(await next.json()).toMatchObject({ text: expect.stringMatching(/isn't set up/) });
    expect(claude.requests).toHaveLength(0);
  });

  test('/start after linking gets a greeting, not a Claude turn', async () => {
    const env = await linkedEnv();
    const claude = new ScriptedClaude([]);
    const res = await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ text: '/start' }));
    expect(await res.json()).toMatchObject({ text: expect.stringMatching(/Attendance Business Agent/) });
    expect(claude.requests).toHaveLength(0);
  });
});

describe('conversations once linked', () => {
  test('a message is answered in the same chat, with typing first and formatting converted', async () => {
    const env = await linkedEnv();
    const calls = stubTelegram();
    const res = await sendViaTelegram(env, createDeps(env, new ScriptedClaude([say('I can file this as *medical leave*. 3 < 5 & ok')])), telegramUpdate({ text: 'I was sick' }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(calls[0].params).toEqual({ chat_id: '777', action: 'typing' });
    expect(calls[1].params).toEqual({ chat_id: '777', text: 'I can file this as <b>medical leave</b>. 3 &lt; 5 &amp; ok', parse_mode: 'HTML' });
    const conv = await env.DB.prepare('SELECT channel, phone_number FROM conversations').first<any>();
    expect(conv).toEqual({ channel: 'telegram', phone_number: PHONE });
  });

  test('if Telegram rejects the formatting, the reply is sent again as plain text', async () => {
    const env = await linkedEnv();
    const calls = stubTelegram({ rejectHtml: true });
    await sendViaTelegram(env, createDeps(env, new ScriptedClaude([say('*hi*')])), telegramUpdate({ text: 'hi' }));
    expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.params)).toEqual([
      { chat_id: '777', text: '<b>hi</b>', parse_mode: 'HTML' },
      { chat_id: '777', text: '*hi*' },
    ]);
  });

  test('YES typed in Telegram submits, exactly as on WhatsApp', async () => {
    const env = await linkedEnv();
    stubTelegram();
    // A draft awaiting confirmation, set up directly.
    const conv = await env.DB.prepare(`INSERT INTO conversations (channel, phone_number) VALUES ('telegram', ?) RETURNING id`).bind(PHONE).first<any>();
    await env.DB.prepare(
      `INSERT INTO drafts (id, conversation_id, phone_number, transaction_type_id, transaction_type_key, reason_code, user_wording, fields, steps, status)
       VALUES ('d-tg', ?, ?, 1, 'leave_application', 'others', 'moving house', ?, ?, 'awaiting_confirmation')`,
    )
      .bind(
        conv.id,
        PHONE,
        JSON.stringify({
          start_date: { value: '2026-11-25', status: 'confirmed' },
          end_date: { value: '2026-11-25', status: 'confirmed' },
          days: { value: 1, status: 'confirmed' },
          reason_description: { value: 'Moving house', status: 'confirmed' },
        }),
        JSON.stringify([{ id: 's1', text: 'Described the reason', status: 'done', note: 'in chat' }]),
      )
      .run();
    const claude = new ScriptedClaude([]);
    await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ text: 'YES' }));
    expect(claude.requests).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT status FROM drafts WHERE id = 'd-tg'`).first<any>()).status).toBe('submitted');
  });

  test('a repeated update is processed once; group chats and edits are ignored', async () => {
    const env = await linkedEnv();
    stubTelegram();
    const claude = new ScriptedClaude([say('one')]);
    const update = telegramUpdate({ text: 'hi' });
    await sendViaTelegram(env, createDeps(env, claude), update);
    await sendViaTelegram(env, createDeps(env, claude), update);
    const group = telegramUpdate({ text: 'hi' });
    (group as any).message.chat = { id: -100, type: 'group' };
    await sendViaTelegram(env, createDeps(env, claude), group);
    await sendViaTelegram(env, createDeps(env, claude), { update_id: 1, edited_message: (telegramUpdate({ text: 'edit' }) as any).message });
    expect(claude.requests).toHaveLength(1);
  });

  test('voice notes get the friendly reply without calling Claude', async () => {
    const env = await linkedEnv();
    const calls = stubTelegram();
    const claude = new ScriptedClaude([]);
    await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ voice: { file_id: 'v1', duration: 3 } }));
    expect(claude.requests).toHaveLength(0);
    expect(calls.find((c) => c.method === 'sendMessage')?.params.text).toMatch(/can't handle voice messages yet/);
  });
});

describe('message parsing', () => {
  test('photo (largest size), PDF document, caption', () => {
    const photo = parseTelegramMessage(
      { message_id: 5, chat: { id: 777 }, caption: 'my MC', photo: [{ file_id: 'small' }, { file_id: 'large' }] },
      '+65 9000 0001',
    );
    expect(photo).toEqual({
      channel: 'telegram', channelMessageId: 'tg-777-5', from: PHONE, receivedOn: '777', type: 'image', text: 'my MC',
      media: { source: 'telegram', fileId: 'large', mimeType: 'image/jpeg' },
    });
    const pdf = parseTelegramMessage({ message_id: 6, chat: { id: 777 }, document: { file_id: 'd1', mime_type: 'application/pdf', file_name: 'mc.pdf' } }, PHONE);
    expect(pdf).toMatchObject({ type: 'document', media: { source: 'telegram', fileId: 'd1', mimeType: 'application/pdf', filename: 'mc.pdf' } });
  });

  test('formatting conversion escapes HTML', () => {
    expect(toTelegramHtml('*Bold* and <script> & _italic_ text')).toBe('<b>Bold</b> and &lt;script&gt; &amp; <i>italic</i> text');
  });
});

describe('the same orchestrator input as the other channels', () => {
  test('a photo with a caption via Telegram and via Mock WhatsApp give Claude the same request', async () => {
    const mockEnv = createTestEnv();
    await seedMockData(mockEnv);
    const mockClaude = new ScriptedClaude([say('ok'), say('ok')]);
    await sendViaSimulator(mockEnv, createDeps(mockEnv, mockClaude), PHONE, 'my MC', { bytes: PNG_BYTES, type: 'image/jpeg', name: 'mc.jpg' });

    const env = await linkedEnv();
    stubTelegram();
    const claude = new ScriptedClaude([say('ok'), say('ok')]);
    await sendViaTelegram(env, createDeps(env, claude), telegramUpdate({ caption: 'my MC', photo: [{ file_id: 'small' }, { file_id: 'large' }] }));

    const comparable = (r: unknown) => JSON.stringify(r).replace(UUID, '<id>');
    expect(comparable(claude.requests[0])).toBe(comparable(mockClaude.requests[0]));
    expect(comparable(claude.requests[0])).toContain('"type":"image"');
    expect((env.EVIDENCE as any).store.size).toBe(1);
  });
});

describe('admin Channels tab', () => {
  test('"Connect Telegram" sets the webhook with the secret and the command menu', async () => {
    const env = telegramEnv();
    const calls = stubTelegram();
    const url = new URL('https://wa-poc.example.workers.dev/admin/channels/telegram/connect');
    const res = await handleAdmin(new Request(url, { method: 'POST' }), env, url);
    expect(res.status).toBe(303);
    const setWebhook = calls.find((c) => c.method === 'setWebhook')!;
    expect(setWebhook.params).toMatchObject({ url: 'https://wa-poc.example.workers.dev/telegram/webhook', allowed_updates: ['message'] });
    expect(setWebhook.params.secret_token).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.find((c) => c.method === 'setMyCommands')?.params.commands.map((c: any) => c.command)).toEqual(['reset', 'cancel']);
  });

  test('the page shows each channel and the linked Telegram accounts', async () => {
    const env = await linkedEnv();
    stubTelegram();
    const url = new URL('https://wa-poc.example.workers.dev/admin/channels');
    const page = await (await handleAdmin(new Request(url), env, url)).text();
    expect(page).toContain('Linked Telegram accounts (1)');
    expect(page).toContain(PHONE);
    expect(page).toContain('@wa_poc_bot');
    expect(page).toContain('Not connected');
  });
});
