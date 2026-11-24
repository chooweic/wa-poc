// Test users of the mock target app, managed on /admin -> Test users.
// In this prototype a user IS their WhatsApp phone number. Leave balances
// are not kept here: they belong to the HR system, which is out of scope.

import { normalizePhone } from '../env';

export interface MockUser {
  phone_number: string;
  name: string;
}

export async function listMockUsers(db: D1Database): Promise<MockUser[]> {
  return (await db.prepare('SELECT phone_number, name FROM mock_users ORDER BY name, phone_number').all<MockUser>()).results;
}

export type UserInput = { phone: string; name: string };

/** Checks and normalises a user typed into the admin form. Returns an error message or the clean values. */
export function parseUserInput(input: UserInput): { error: string } | { user: MockUser } {
  const phone = normalizePhone(input.phone);
  if (phone.length < 6 || phone.length > 15) {
    return { error: 'Enter the phone number in international format, digits only, e.g. 6591234567 (6 to 15 digits).' };
  }
  const name = input.name.trim().slice(0, 80);
  if (!name) return { error: 'Please enter a name.' };
  return { user: { phone_number: phone, name } };
}

/** Adds a user, or renames them if the phone number already exists. */
export async function saveMockUser(db: D1Database, user: MockUser): Promise<void> {
  await db
    .prepare('INSERT INTO mock_users (phone_number, name) VALUES (?1, ?2) ON CONFLICT (phone_number) DO UPDATE SET name = ?2')
    .bind(user.phone_number, user.name)
    .run();
}

/** Removes a user. Their past records stay in the mock target app for reference. */
export async function deleteMockUser(db: D1Database, phone: string): Promise<void> {
  await db.prepare('DELETE FROM mock_users WHERE phone_number = ?').bind(normalizePhone(phone)).run();
}
