// Test users of the mock target app, managed on /admin -> Test users.
// In this prototype a user IS their WhatsApp phone number.

import { normalizePhone } from '../env';

export interface MockUser {
  phone_number: string;
  name: string;
  sick_leave_balance: number;
  off_day_balance: number;
  unpaid_days_taken: number;
}

export async function listMockUsers(db: D1Database): Promise<MockUser[]> {
  return (await db.prepare('SELECT * FROM mock_users ORDER BY name, phone_number').all<MockUser>()).results;
}

export type UserInput = { phone: string; name: string; sick: string; off: string; unpaid: string };

/** Checks and normalises a user typed into the admin form. Returns an error message or the clean values. */
export function parseUserInput(input: UserInput): { error: string } | { user: MockUser } {
  const phone = normalizePhone(input.phone);
  if (phone.length < 6 || phone.length > 15) {
    return { error: 'Enter the phone number in international format, digits only, e.g. 6591234567 (6 to 15 digits).' };
  }
  const name = input.name.trim().slice(0, 80);
  if (!name) return { error: 'Please enter a name.' };
  const numbers: number[] = [];
  for (const [label, raw] of [['Medical leave left', input.sick], ['Off days left', input.off], ['Unpaid days taken', input.unpaid]] as const) {
    const n = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 999) return { error: `${label} must be a number from 0 to 999.` };
    numbers.push(Math.round(n * 2) / 2); // half days are allowed
  }
  const [sick, off, unpaid] = numbers;
  return { user: { phone_number: phone, name, sick_leave_balance: sick, off_day_balance: off, unpaid_days_taken: unpaid } };
}

/** Adds a user, or updates them if the phone number already exists. */
export async function saveMockUser(db: D1Database, user: MockUser): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mock_users (phone_number, name, sick_leave_balance, off_day_balance, unpaid_days_taken)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (phone_number) DO UPDATE SET name = ?2, sick_leave_balance = ?3, off_day_balance = ?4, unpaid_days_taken = ?5`,
    )
    .bind(user.phone_number, user.name, user.sick_leave_balance, user.off_day_balance, user.unpaid_days_taken)
    .run();
}

/** Removes a user. Their past records stay in the mock target app for reference. */
export async function deleteMockUser(db: D1Database, phone: string): Promise<void> {
  await db.prepare('DELETE FROM mock_users WHERE phone_number = ?').bind(normalizePhone(phone)).run();
}
