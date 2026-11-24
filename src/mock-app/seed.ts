// Demo data for the mock target app. Used by the "reset demo data" button and
// automatically the first time the app runs with an empty `mock_users` table.

import { getConfig, type Env } from '../env';

const FAKE_USERS = [
  { phone: '6590000001', name: 'Aisha Rahman', sick: 14, off: 4 },
  { phone: '6590000002', name: 'Tan Wei Ming', sick: 9, off: 2 },
  { phone: '6590000003', name: 'Priya Nair', sick: 1, off: 0 },
];

/**
 * Deletes the mock target app's records and API log, and puts the built-in
 * demo users (and the numbers in ALLOWED_WHATSAPP_NUMBERS) back to their
 * starting balances. Test users added on /admin are kept as they are.
 */
export async function seedMockData(env: Env): Promise<void> {
  const db = env.DB;
  const statements = [db.prepare('DELETE FROM mock_api_log'), db.prepare('DELETE FROM mock_leave_records')];
  const insert = `INSERT INTO mock_users (phone_number, name, sick_leave_balance, off_day_balance, unpaid_days_taken)
    VALUES (?1, ?2, ?3, ?4, 0)
    ON CONFLICT (phone_number) DO UPDATE SET name = ?2, sick_leave_balance = ?3, off_day_balance = ?4, unpaid_days_taken = 0`;
  for (const u of FAKE_USERS) statements.push(db.prepare(insert).bind(u.phone, u.name, u.sick, u.off));
  // Your own test number(s): whatever is listed in ALLOWED_WHATSAPP_NUMBERS.
  let n = 0;
  for (const phone of getConfig(env).allowedNumbers) {
    n += 1;
    statements.push(db.prepare(insert).bind(phone, n === 1 ? 'My test phone' : `My test phone ${n}`, 14, 6));
  }
  await db.batch(statements);
}

export async function ensureMockSeed(env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_users').first<{ n: number }>();
  if (!row?.n) await seedMockData(env);
}

/** Clears chats, drafts and uploaded files (the KB and the mock target app data are left alone). */
export async function clearConversations(env: Env): Promise<void> {
  const keys = (await env.DB.prepare('SELECT r2_key FROM evidence').all<{ r2_key: string }>()).results.map((r) => r.r2_key);
  for (let i = 0; i < keys.length; i += 500) await env.EVIDENCE.delete(keys.slice(i, i + 500));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM evidence'),
    env.DB.prepare('DELETE FROM drafts'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM conversations'),
    env.DB.prepare('DELETE FROM mock_wa_messages'),
  ]);
}
