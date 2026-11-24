// One knowledge base: transaction types and their reasons (no articles), and
// what an inactive transaction type does to its reasons.

import { expect, test } from 'vitest';
import { renderKb } from '../src/claude/prompt';
import { loadActiveKb } from '../src/kb-repo';
import { handleAdmin } from '../src/ui/admin';
import { createTestEnv } from './helpers';

test('the KB sent to Claude is only transaction types and reasons', async () => {
  const env = createTestEnv();
  const text = renderKb(await loadActiveKb(env.DB));
  expect(text).toContain('## Transaction type: Leave application');
  expect(text).toContain('### Reason: Off granted by supervisor');
  expect(text).not.toMatch(/article/i);
  expect(await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'kb_articles'`).first()).toBeNull();
});

test('an inactive transaction type hides all its reasons from Claude, and the admin page says so', async () => {
  const env = createTestEnv();
  await env.DB.prepare('UPDATE kb_transaction_types SET is_active = 0 WHERE id = 1').run();
  expect(renderKb(await loadActiveKb(env.DB))).toContain('No transaction types are active at the moment.');

  const url = new URL('https://app.test/admin/kb');
  const page = await (await handleAdmin(new Request(url), env, url)).text();
  expect(page).toContain('This transaction type is off.');
  expect(page).toContain('Hidden: type is off');
  expect(page).not.toMatch(/Articles|Add an article/);
});

test('article pages are gone', async () => {
  const env = createTestEnv();
  const url = new URL('https://app.test/admin/kb/articles/new');
  expect((await handleAdmin(new Request(url), env, url)).status).toBe(404);
});
