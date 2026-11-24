import { expect, test } from 'vitest';
import { loadActiveKb } from '../src/kb-repo';
import { createTestDb } from './helpers';

test('migrations load and the demo KB is present', async () => {
  const kb = await loadActiveKb(createTestDb());
  expect(kb.types.map((t) => t.key)).toEqual(['leave_application']);
  expect(kb.types[0].reasons.map((r) => r.code)).toEqual(['medical', 'supervisor_granted_off', 'no_pay_leave', 'others']);
  expect(kb.articles.length).toBeGreaterThan(1);
});
