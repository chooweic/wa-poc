// Test users of the mock target app (Admin -> Test users) and the demo reset.

import { beforeEach, describe, expect, test } from 'vitest';
import { seedMockData } from '../src/mock-app/seed';
import { listMockUsers, parseUserInput } from '../src/mock-app/users';
import { handleAdmin } from '../src/ui/admin';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = createTestEnv();
  await seedMockData(env);
});

async function post(path: string, fields: Record<string, string>) {
  const url = new URL(`https://app.test${path}`);
  const body = new URLSearchParams(fields);
  return handleAdmin(new Request(url, { method: 'POST', body }), env, url);
}
const user = (phone: string) => env.DB.prepare('SELECT * FROM mock_users WHERE phone_number = ?').bind(phone).first<any>();

describe('adding and editing test users', () => {
  test('a new user is added with the number normalised to digits', async () => {
    const res = await post('/admin/users/save', { phone: '+65 9123 4567', name: 'Siti', sick: '10', off: '2.5', unpaid: '' });
    expect(res.status).toBe(303);
    expect(await user('6591234567')).toEqual({
      phone_number: '6591234567', name: 'Siti', sick_leave_balance: 10, off_day_balance: 2.5, unpaid_days_taken: 0,
    });
  });

  test('saving an existing number updates that user', async () => {
    await post('/admin/users/save', { phone: '6590000001', name: 'Aisha R.', sick: '3', off: '1', unpaid: '2' });
    expect(await user('6590000001')).toMatchObject({ name: 'Aisha R.', sick_leave_balance: 3, off_day_balance: 1, unpaid_days_taken: 2 });
    expect(await listMockUsers(env.DB)).toHaveLength(3);
  });

  test('bad input is refused with a message and nothing is saved', async () => {
    const res = await post('/admin/users/save', { phone: '12', name: 'Too short', sick: '1', off: '1', unpaid: '0' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Not saved\. Enter the phone number in international format/);
    expect(parseUserInput({ phone: '6591234567', name: ' ', sick: '1', off: '1', unpaid: '0' })).toEqual({ error: 'Please enter a name.' });
    expect(parseUserInput({ phone: '6591234567', name: 'X', sick: '-1', off: '1', unpaid: '0' })).toEqual({
      error: 'Medical leave left must be a number from 0 to 999.',
    });
    expect(await listMockUsers(env.DB)).toHaveLength(3);
  });

  test('a user can be removed', async () => {
    await post('/admin/users/delete', { phone: '6590000003' });
    expect(await user('6590000003')).toBeNull();
  });

  test('the Test users page lists the users', async () => {
    const url = new URL('https://app.test/admin/users');
    const page = await (await handleAdmin(new Request(url), env, url)).text();
    expect(page).toContain('Add a test user');
    expect(page).toContain('6590000002');
    expect(page).toContain('Attendance Business Agent');
  });
});

describe('reset demo data', () => {
  test('keeps added users, restores the demo users and clears records and the API log', async () => {
    await post('/admin/users/save', { phone: '6598887777', name: 'Added later', sick: '5', off: '5', unpaid: '0' });
    await env.DB.prepare(`UPDATE mock_users SET sick_leave_balance = 0, unpaid_days_taken = 4 WHERE phone_number = '6590000001'`).run();
    await env.DB.prepare(`DELETE FROM mock_users WHERE phone_number = '6590000002'`).run();
    await env.DB.prepare(`INSERT INTO mock_api_log (method, path, request_json, response_json, status) VALUES ('POST', '/x', '{}', '{}', 201)`).run();

    await post('/admin/demo/reset-demo', {});

    expect(await user('6598887777')).toMatchObject({ name: 'Added later', sick_leave_balance: 5 });
    expect(await user('6590000001')).toMatchObject({ sick_leave_balance: 14, unpaid_days_taken: 0 });
    expect(await user('6590000002')).toMatchObject({ name: 'Tan Wei Ming' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_api_log').first<any>()).n).toBe(0);
  });
});
