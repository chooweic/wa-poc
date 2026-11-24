// Test doubles for the Cloudflare bindings, so tests run in plain Node:
//  - D1  -> an in-memory SQLite database (node:sqlite) loaded with the real migrations
//  - R2  -> a Map
//  - Queue -> an array
// plus a scripted stand-in for Claude.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ClaudeClient, ClaudeMessage, ClaudeRequest } from '../src/claude/client';
import { getConfig, type Env, type QueueJob } from '../src/env';
import type { OrchestratorDeps } from '../src/orchestrator';
import { MockTargetAppClient } from '../src/target/mock-client';

const MIGRATIONS = join(__dirname, '..', 'migrations');

class FakeStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new FakeStatement(this.sqlite, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...(this.params as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...(this.params as never[])) as T[] };
  }
  async run() {
    const r = this.sqlite.prepare(this.sql).run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  return {
    prepare: (sql: string) => new FakeStatement(sqlite, sql),
    async batch(statements: FakeStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

export function createTestBucket(): R2Bucket & { store: Map<string, ArrayBuffer> } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async put(key: string, value: ArrayBuffer) {
      store.set(key, value);
    },
    async get(key: string) {
      const value = store.get(key);
      return value ? { arrayBuffer: async () => value, body: value } : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  } as unknown as R2Bucket & { store: Map<string, ArrayBuffer> };
}

export interface TestEnv extends Env {
  jobs: QueueJob[];
}

export function createTestEnv(overrides: Partial<Env> = {}): TestEnv {
  const jobs: QueueJob[] = [];
  return {
    DB: createTestDb(),
    EVIDENCE: createTestBucket(),
    INBOUND_QUEUE: { send: async (job: QueueJob) => void jobs.push(job) } as unknown as Queue<QueueJob>,
    jobs,
    ADMIN_PASSWORD: 'test-password',
    ...overrides,
  };
}

type Reply = Partial<ClaudeMessage>;
type Scripted = Reply | ((request: ClaudeRequest) => Reply | Promise<Reply>);

/** A fake Claude that returns pre-written responses in order and records every request. */
export class ScriptedClaude implements ClaudeClient {
  readonly requests: ClaudeRequest[] = [];
  constructor(private readonly script: Scripted[]) {}
  async create(request: ClaudeRequest): Promise<ClaudeMessage> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedClaude: no more scripted responses');
    return (typeof next === 'function' ? await next(request) : next) as ClaudeMessage;
  }
}

export const say = (text: string): Partial<ClaudeMessage> => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text, citations: null }] as ClaudeMessage['content'],
});

let toolCounter = 0;
export const callTools = (...calls: [name: string, input: Record<string, unknown>][]): Partial<ClaudeMessage> => ({
  stop_reason: 'tool_use',
  content: calls.map(([name, input]) => ({ type: 'tool_use', id: `toolu_${++toolCounter}`, name, input })) as ClaudeMessage['content'],
});

export function createDeps(env: Env, claude: ClaudeClient | null, now = new Date('2026-11-24T02:00:00Z')): OrchestratorDeps {
  return {
    db: env.DB,
    bucket: env.EVIDENCE,
    claude,
    target: new MockTargetAppClient(env.DB),
    config: getConfig(env),
    now: () => now,
  };
}

/** A tiny valid-looking PNG header; the fake Claude never decodes it. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).buffer;

// ------------------------------------------------- driving whole turns

import { processJob } from '../src/pipeline';
import { handleMockWa } from '../src/ui/mock-wa';
import { toHex } from '../src/util';
import { handleWebhookPost } from '../src/webhook';

async function drainQueue(env: TestEnv, deps: OrchestratorDeps): Promise<void> {
  while (env.jobs.length) await processJob(env, env.jobs.shift() as QueueJob, deps);
}

async function outboundTexts(env: Env, phone: string, afterId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT body FROM mock_wa_messages WHERE phone_number = ? AND direction = 'out' AND id > ? ORDER BY id`,
  )
    .bind(phone, afterId)
    .all<{ body: string }>();
  return rows.results.map((r) => r.body);
}

/** Sends a message through the simulator's real HTTP route, runs the queue, and returns the bot's replies. */
export async function sendViaSimulator(
  env: TestEnv,
  deps: OrchestratorDeps,
  phone: string,
  text: string,
  file?: { bytes: ArrayBuffer; type: string; name: string },
): Promise<string[]> {
  const last = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mock_wa_messages').first<{ id: number }>();
  const form = new FormData();
  form.append('phone', phone);
  form.append('text', text);
  if (file) form.append('file', new File([file.bytes], file.name, { type: file.type }));
  const url = new URL('https://app.test/mock-wa/api/send');
  const response = await handleMockWa(new Request(url, { method: 'POST', body: form }), env, url);
  if (response.status !== 200) throw new Error(`simulator send failed: ${response.status} ${await response.text()}`);
  await drainQueue(env, deps);
  return outboundTexts(env, phone, last?.id ?? 0);
}

export async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`;
}

/** Wraps WhatsApp message objects in the envelope Meta posts to the webhook. */
export function metaEnvelope(...messages: Record<string, unknown>[]): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PHONE_ID' },
              contacts: [{ profile: { name: 'Test' }, wa_id: '6590000001' }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

export const META_SECRETS = {
  WHATSAPP_ACCESS_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: 'PHONE_ID',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
};

/** Posts a signed webhook to the real handler, then runs the queue. Returns the HTTP status. */
export async function sendViaWebhook(env: TestEnv, deps: OrchestratorDeps, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  const request = new Request('https://app.test/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': await sign(body, env.WHATSAPP_APP_SECRET ?? ''), 'content-type': 'application/json' },
    body,
  });
  const response = await handleWebhookPost(request, env);
  await drainQueue(env, deps);
  return response.status;
}

// ------------------------------------------------- Twilio

import { computeTwilioSignature, handleTwilioWebhook } from '../src/twilio-webhook';

export const TWILIO_SETTINGS = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'twilio-token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};

export const TWILIO_URL = 'https://app.test/twilio/webhook';

/** Form fields Twilio sends for an incoming WhatsApp message. */
export function twilioFields(fields: Record<string, string>): Record<string, string> {
  return {
    SmsMessageSid: fields.MessageSid ?? 'SM0001',
    NumMedia: '0',
    ProfileName: 'Test',
    SmsSid: fields.MessageSid ?? 'SM0001',
    WaId: '6590000001',
    SmsStatus: 'received',
    To: 'whatsapp:+14155238886',
    NumSegments: '1',
    MessageType: 'text',
    AccountSid: TWILIO_SETTINGS.TWILIO_ACCOUNT_SID,
    From: 'whatsapp:+6590000001',
    ApiVersion: '2010-04-01',
    ...fields,
  };
}

/** Posts a signed Twilio webhook to the real handler, then runs the queue. Returns the HTTP response. */
export async function sendViaTwilio(env: TestEnv, deps: OrchestratorDeps, fields: Record<string, string>, signature?: string) {
  const body = new URLSearchParams(fields).toString();
  const sig = signature ?? (await computeTwilioSignature(TWILIO_URL, Object.entries(fields), env.TWILIO_AUTH_TOKEN || 'unset'));
  const response = await handleTwilioWebhook(
    new Request(TWILIO_URL, { method: 'POST', headers: { 'x-twilio-signature': sig, 'content-type': 'application/x-www-form-urlencoded' }, body }),
    env,
  );
  await drainQueue(env, deps);
  return response;
}
