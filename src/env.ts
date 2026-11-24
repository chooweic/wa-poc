// Bindings and settings available to the Worker.
// Bindings (DB, EVIDENCE, INBOUND_QUEUE) are declared in wrangler.jsonc.
// Everything else is a secret or variable: `.dev.vars` locally,
// `wrangler secret put` in production.

export interface QueueJob {
  /** Row id in the `messages` table of the inbound message to process. */
  messageId: number;
  /** Origin of the request that received the message, used to build evidence links. */
  origin?: string;
}

export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  INBOUND_QUEUE: Queue<QueueJob>;

  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string; // only for tests against a stub server
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  CLAUDE_MAX_TOKENS?: string;
  CLAUDE_STRICT_TOOLS?: string;

  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_API_VERSION?: string;
  ALLOWED_WHATSAPP_NUMBERS?: string;

  ADMIN_PASSWORD?: string;

  APP_TIMEZONE?: string;
  HISTORY_MESSAGES?: string;
  MAX_UPLOAD_MB?: string;

  TARGET_APP_MODE?: string; // "mock" (default) or "http"
  TARGET_APP_URL?: string;
  TARGET_APP_API_KEY?: string;
}

export type Effort = 'low' | 'medium' | 'high';

export interface Config {
  claudeModel: string;
  claudeEffort: Effort;
  claudeMaxTokens: number;
  claudeStrictTools: boolean;
  timezone: string;
  historyMessages: number;
  maxUploadBytes: number;
  allowedNumbers: Set<string>;
  /** True when every secret the real WhatsApp channel needs is present. */
  metaEnabled: boolean;
  whatsappApiVersion: string;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Digits only: "+65 9123 4567" -> "6591234567". */
export function normalizePhone(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

export function getConfig(env: Env): Config {
  const effort = (env.CLAUDE_EFFORT ?? 'low').toLowerCase();
  return {
    claudeModel: env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
    claudeEffort: effort === 'medium' || effort === 'high' ? effort : 'low',
    claudeMaxTokens: intOr(env.CLAUDE_MAX_TOKENS, 4000),
    claudeStrictTools: (env.CLAUDE_STRICT_TOOLS ?? 'on').toLowerCase() !== 'off',
    timezone: env.APP_TIMEZONE?.trim() || 'Asia/Singapore',
    historyMessages: intOr(env.HISTORY_MESSAGES, 20),
    maxUploadBytes: intOr(env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
    allowedNumbers: new Set(
      (env.ALLOWED_WHATSAPP_NUMBERS ?? '')
        .split(',')
        .map(normalizePhone)
        .filter(Boolean),
    ),
    metaEnabled: Boolean(
      env.WHATSAPP_ACCESS_TOKEN &&
        env.WHATSAPP_PHONE_NUMBER_ID &&
        env.WHATSAPP_APP_SECRET &&
        env.WHATSAPP_VERIFY_TOKEN,
    ),
    whatsappApiVersion: env.WHATSAPP_API_VERSION?.trim() || 'v25.0',
  };
}
