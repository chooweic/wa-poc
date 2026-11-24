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
const users = async () => (await env.DB.prepare('SELECT * FROM mock_users').all<any>()).results;

describe('adding and editing test users', () => {
  test('a new user is added with the number normalised to digits', async () => {
    const res = await post('/admin/users/save', { phone: '+65 9123 4567', name: 'Siti' });
    expect(res.status).toBe(303);
    expect(await user('6591234567')).toEqual({ phone_number: '6591234567', name: 'Siti' });
  });

  test('saving an existing number renames that user', async () => {
    await post('/admin/users/save', { phone: '6590000001', name: 'Aisha R.' });
    expect(await user('6590000001')).toEqual({ phone_number: '6590000001', name: 'Aisha R.' });
    expect(await listMockUsers(env.DB)).toHaveLength(3);
  });

  test('bad input is refused with a message and nothing is saved', async () => {
    const res = await post('/admin/users/save', { phone: '12', name: 'Too short' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Not saved\. Enter the phone number in international format/);
    expect(parseUserInput({ phone: '6591234567', name: ' ' })).toEqual({ error: 'Please enter a name.' });
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
    await post('/admin/users/save', { phone: '6598887777', name: 'Added later' });
    await env.DB.prepare(`DELETE FROM mock_users WHERE phone_number = '6590000002'`).run();
    await env.DB.prepare(`INSERT INTO mock_api_log (method, path, request_json, response_json, status) VALUES ('POST', '/x', '{}', '{}', 201)`).run();

    await post('/admin/demo/reset-demo', {});

    expect(await user('6598887777')).toEqual({ phone_number: '6598887777', name: 'Added later' });
    expect(await user('6590000002')).toEqual({ phone_number: '6590000002', name: 'Tan Wei Ming' });
    expect(await users()).toHaveLength(4);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_api_log').first<any>()).n).toBe(0);
  });
});
