// Small shared helpers: HTTP responses, HTML escaping, time, hashing.

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marks a string as already-safe HTML so `html` does not escape it again. */
export class Raw {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
export const raw = (value: string): Raw => new Raw(value);

/**
 * Tagged template that HTML-escapes every interpolated value unless it is
 * `Raw` (or an array of `Raw`). Keeps the server-rendered admin pages safe
 * from user-supplied text.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += renderValue(values[i]);
  });
  return new Raw(out);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escapeHtml(v);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** Compares two strings without leaking where they differ (for passwords and signatures). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** "Medical leave" -> "medical_leave". Used to generate keys and codes from labels. */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || 'item';
}

/** Date and weekday in the app's time zone, e.g. { date: "2026-11-24", weekday: "Tuesday", time: "10:32" }. */
export function localDateParts(now: Date, timeZone: string): { date: string; weekday: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    time: `${get('hour')}:${get('minute')}`,
  };
}
