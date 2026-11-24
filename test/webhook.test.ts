import { describe, expect, test } from 'vitest';
import { handleWebhookPost, handleWebhookVerify, parseWebhookPayload, verifySignature } from '../src/webhook';
import { createTestEnv, META_SECRETS, metaEnvelope, sign } from './helpers';

describe('signature verification', () => {
  const body = JSON.stringify({ hello: 'world' });

  test('accepts a correct signature', async () => {
    expect(await verifySignature(body, await sign(body, 's3cret'), 's3cret')).toBe(true);
  });
  test('rejects a wrong secret, a changed body, and a missing or malformed header', async () => {
    const good = await sign(body, 's3cret');
    expect(await verifySignature(body, await sign(body, 'other'), 's3cret')).toBe(false);
    expect(await verifySignature(body + ' ', good, 's3cret')).toBe(false);
    expect(await verifySignature(body, null, 's3cret')).toBe(false);
    expect(await verifySignature(body, good.replace('sha256=', ''), 's3cret')).toBe(false);
    expect(await verifySignature(body, good, '')).toBe(false);
  });
});

describe('message parsing', () => {
  test('text', () => {
    const [m] = parseWebhookPayload(metaEnvelope({ id: 'wamid.1', from: '6590000001', type: 'text', text: { body: 'I am sick' } }));
    expect(m).toEqual({ channel: 'meta', channelMessageId: 'wamid.1', from: '6590000001', type: 'text', text: 'I am sick' });
  });
  test('image with caption', () => {
    const [m] = parseWebhookPayload(
      metaEnvelope({ id: 'wamid.2', from: '6590000001', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'my MC' } }),
    );
    expect(m).toMatchObject({ type: 'image', text: 'my MC', media: { source: 'meta', mediaId: 'MEDIA1', mimeType: 'image/jpeg' } });
  });
  test('document (PDF) without caption', () => {
    const [m] = parseWebhookPayload(
      metaEnvelope({ id: 'wamid.3', from: '6590000001', type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'mc.pdf' } }),
    );
    expect(m).toMatchObject({ type: 'document', text: '', media: { mediaId: 'MEDIA2', mimeType: 'application/pdf', filename: 'mc.pdf' } });
  });
  test('unsupported kinds get a friendly reply instead of content', () => {
    const [m] = parseWebhookPayload(metaEnvelope({ id: 'wamid.4', from: '6590000001', type: 'audio', audio: { id: 'A1' } }));
    expect(m.type).toBe('unsupported');
    expect(m.text).toMatch(/photo \(JPEG or PNG\) or a PDF/);
  });
  test('status updates are ignored', () => {
    const payload = metaEnvelope();
    (payload.entry as any)[0].changes[0].value = { statuses: [{ id: 'wamid.1', status: 'delivered' }] };
    expect(parseWebhookPayload(payload)).toEqual([]);
  });
});

describe('webhook endpoint', () => {
  const textPayload = (id: string, from = '6590000001') => metaEnvelope({ id, from, type: 'text', text: { body: 'hi' } });
  const post = async (env: any, payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return handleWebhookPost(
      new Request('https://app.test/webhook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signature ?? (await sign(body, META_SECRETS.WHATSAPP_APP_SECRET)) },
        body,
      }),
      env,
    );
  };

  test('GET handshake echoes the challenge only for the right token', () => {
    const env = createTestEnv(META_SECRETS);
    const ok = handleWebhookVerify(new Request('https://app.test/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345'), env);
    expect(ok.status).toBe(200);
    const bad = handleWebhookVerify(new Request('https://app.test/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345'), env);
    expect(bad.status).toBe(403);
  });

  test('a bad signature is rejected and nothing is queued', async () => {
    const env = createTestEnv({ ...META_SECRETS, ALLOWED_WHATSAPP_NUMBERS: '6590000001' });
    expect((await post(env, textPayload('wamid.a'), 'sha256=00')).status).toBe(401);
    expect(env.jobs).toHaveLength(0);
  });

  test('queues an allowed message once, even if Meta delivers it twice', async () => {
    const env = createTestEnv({ ...META_SECRETS, ALLOWED_WHATSAPP_NUMBERS: '+65 9000 0001' });
    expect((await post(env, textPayload('wamid.b'))).status).toBe(200);
    expect((await post(env, textPayload('wamid.b'))).status).toBe(200);
    expect(env.jobs).toHaveLength(1);
  });

  test('ignores numbers that are not in ALLOWED_WHATSAPP_NUMBERS', async () => {
    const env = createTestEnv({ ...META_SECRETS, ALLOWED_WHATSAPP_NUMBERS: '6590000001' });
    expect((await post(env, textPayload('wamid.c', '6599999999'))).status).toBe(200);
    expect(env.jobs).toHaveLength(0);
  });

  test('is disabled when the WHATSAPP_* secrets are missing', async () => {
    expect((await post(createTestEnv(), textPayload('wamid.d'))).status).toBe(503);
  });
});
