// Migration 0004 rebuilds `conversations` and the three tables that reference
// it. Existing rows must survive, and the rules (foreign keys, cascades,
// one open draft per user) must still hold afterwards.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

const DIR = join(__dirname, '..', 'migrations');
const files = readdirSync(DIR).sort();

test('0004 keeps every row and every rule, and allows the twilio channel', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of files.filter((f) => f < '0004')) db.exec(readFileSync(join(DIR, f), 'utf8'));

  db.exec(`
    INSERT INTO conversations (id, channel, phone_number) VALUES (7, 'meta', '6590000001'), (8, 'mock', '6590000002');
    INSERT INTO messages (conversation_id, direction, channel_message_id, text) VALUES (7, 'in', 'wamid.1', 'hello'), (8, 'in', 'mock-1', 'hi');
    INSERT INTO drafts (id, conversation_id, phone_number, transaction_type_id, transaction_type_key) VALUES ('d1', 7, '6590000001', 1, 'leave_application');
    INSERT INTO evidence (id, conversation_id, draft_id, kind, mime_type, size_bytes, sha256, r2_key) VALUES ('e1', 7, 'd1', 'image', 'image/png', 1, 'x', 'k');
  `);
  expect(() => db.exec(`INSERT INTO conversations (channel, phone_number) VALUES ('twilio', '1')`)).toThrow();

  db.exec(readFileSync(join(DIR, '0004_twilio_channel.sql'), 'utf8'));

  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  expect([count('conversations'), count('messages'), count('drafts'), count('evidence')]).toEqual([2, 2, 1, 1]);
  expect(db.prepare('SELECT id, channel FROM conversations ORDER BY id').all()).toEqual([
    { id: 7, channel: 'meta' },
    { id: 8, channel: 'mock' },
  ]);

  // The new channel is allowed; ids keep counting up.
  db.exec(`INSERT INTO conversations (channel, phone_number) VALUES ('twilio', '6590000001')`);
  expect((db.prepare(`SELECT id FROM conversations WHERE channel = 'twilio'`).get() as any).id).toBe(9);

  // Child tables point at the renamed table, and the rules still apply.
  for (const t of ['messages', 'drafts', 'evidence']) {
    expect((db.prepare(`PRAGMA foreign_key_list(${t})`).all() as any[]).map((r) => r.table)).toEqual(['conversations']);
  }
  expect(() => db.exec(`INSERT INTO messages (conversation_id, direction) VALUES (999, 'in')`)).toThrow();
  expect(() =>
    db.exec(`INSERT INTO drafts (id, conversation_id, phone_number, transaction_type_id, transaction_type_key) VALUES ('d2', 7, 'x', 1, 'k')`),
  ).toThrow(); // one open draft per conversation
  expect(() => db.exec(`INSERT INTO messages (conversation_id, direction, channel_message_id) VALUES (8, 'in', 'wamid.1')`)).toThrow();
  db.exec('DELETE FROM conversations WHERE id = 7');
  expect([count('messages'), count('drafts'), count('evidence')]).toEqual([1, 0, 0]); // cascade still works
});
