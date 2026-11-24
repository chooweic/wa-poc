import { beforeEach, describe, expect, test } from 'vitest';
import type { Draft, EvidenceRecord } from '../src/drafts-repo';
import { loadActiveKb } from '../src/kb-repo';
import { getMockState, handleMockTransaction } from '../src/mock-app/api';
import { seedMockData } from '../src/mock-app/seed';
import { buildPayload, type TransactionPayload } from '../src/target/payload';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = createTestEnv();
  await seedMockData(env);
});

const payload = (over: Partial<TransactionPayload> = {}): TransactionPayload => ({
  reference: crypto.randomUUID(),
  transaction_type: 'leave_application',
  reason_code: 'medical',
  reason_label: 'Medical leave',
  user_wording: 'I had a fever',
  phone_number: '6590000001',
  fields: { start_date: '2026-11-23', end_date: '2026-11-24', days: 2, clinic: 'Sunrise' },
  evidence: [{ id: 'ev-1', type: 'image', mime_type: 'image/jpeg', link: 'https://app.test/evidence/ev-1' }],
  checklist: [{ step: 'Got an MC', status: 'done', note: 'seen on MC' }],
  ...over,
});
const submit = (p: unknown) => handleMockTransaction(env.DB, p, (p as any)?.reference ?? null);
const user = (phone: string) => env.DB.prepare('SELECT * FROM mock_users WHERE phone_number = ?').bind(phone).first<any>();

describe('building the generic payload', () => {
  test('one fixed shape: type, reason, wording, phone, confirmed fields, evidence links, checklist, reference', async () => {
    const kb = await loadActiveKb(env.DB);
    const type = kb.types[0];
    const reason = type.reasons.find((r) => r.code === 'medical')!;
    const draft = {
      id: 'draft-123',
      phone_number: '6590000001',
      user_wording: 'down with flu',
      fields: {
        start_date: { value: '2026-11-23', status: 'confirmed' },
        days: { value: 1, status: 'confirmed' },
        mc_number: { value: 'maybe 4471?', status: 'unconfirmed' },
      },
      notes: [{ text: 'supervisor will confirm tomorrow', at: '2026-11-24T00:00:00Z' }],
      steps: [{ id: 's1', text: 'Informed supervisor', status: 'done', note: 'user confirmed in chat' }],
    } as unknown as Draft;
    const evidence = [{ id: 'ev-9', kind: 'image', mime_type: 'image/jpeg' }] as EvidenceRecord[];

    const built = buildPayload({ draft, type, reason, evidence, baseUrl: 'https://wa-poc.example.workers.dev/' });
    expect(built).toEqual({
      reference: 'draft-123',
      transaction_type: 'leave_application',
      reason_code: 'medical',
      reason_label: 'Medical leave',
      user_wording: 'down with flu',
      phone_number: '6590000001',
      fields: { start_date: '2026-11-23', days: 1 }, // unconfirmed values are left out
      evidence: [{ id: 'ev-9', type: 'image', mime_type: 'image/jpeg', link: 'https://wa-poc.example.workers.dev/evidence/ev-9' }],
      checklist: [{ step: 'Informed supervisor', status: 'done', note: 'user confirmed in chat' }],
    });
    expect(JSON.stringify(built)).not.toContain('supervisor will confirm tomorrow'); // notes never leave the app
  });
});

describe('mock target application: POST /mock-api/transactions', () => {
  test('medical leave is approved and deducts the sick-leave balance', async () => {
    const result = await submit(payload());
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ reference_no: 'HR-000001', status: 'approved', days: 2 });
    expect((await user('6590000001')).sick_leave_balance).toBe(12);
  });

  test('off granted by supervisor deducts the off-day balance', async () => {
    const result = await submit(payload({ reason_code: 'supervisor_granted_off', fields: { start_date: '2026-11-27', end_date: '2026-11-27', days: 1 } }));
    expect(result.body.status).toBe('approved');
    expect((await user('6590000001')).off_day_balance).toBe(3);
  });

  test('no pay leave records unpaid days', async () => {
    await submit(payload({ reason_code: 'no_pay_leave', fields: { start_date: '2026-12-01', end_date: '2026-12-03', days: 3 } }));
    expect(await user('6590000001')).toMatchObject({ unpaid_days_taken: 3, sick_leave_balance: 14 });
  });

  test('"others" is recorded as pending_review and touches no balance', async () => {
    const result = await submit(payload({ reason_code: 'others' }));
    expect(result.body.status).toBe('pending_review');
    expect(await user('6590000001')).toMatchObject({ sick_leave_balance: 14, off_day_balance: 4, unpaid_days_taken: 0 });
  });

  test('an unknown reason code (one just added in the KB) is accepted as pending_review', async () => {
    const result = await submit(payload({ reason_code: 'childcare_leave', reason_label: 'Childcare leave' }));
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('pending_review');
    const record = await env.DB.prepare('SELECT * FROM mock_leave_records').first<any>();
    expect(record).toMatchObject({ reason_code: 'childcare_leave', reason_label: 'Childcare leave', status: 'pending_review', user_wording: 'I had a fever' });
  });

  test('rejects a phone number with no matching user (404)', async () => {
    const result = await submit(payload({ phone_number: '6599999999' }));
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('user_not_found');
  });

  test('rejects a duplicate reference (409) and does not deduct twice', async () => {
    const p = payload();
    await submit(p);
    const again = await submit(p);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'duplicate_reference' }, reference_no: 'HR-000001' });
    expect((await user('6590000001')).sick_leave_balance).toBe(12);
  });

  test('rejects malformed requests (400) and bad dates or days (422)', async () => {
    expect((await submit(null)).status).toBe(400);
    expect((await submit({ ...payload(), reason_code: '' })).status).toBe(400);
    expect((await submit({ ...payload(), fields: 'none' })).status).toBe(400);
    expect((await submit(payload({ fields: { start_date: '2026-11-24', end_date: '2026-11-23', days: 1 } }))).status).toBe(422);
    expect((await submit(payload({ fields: { start_date: '2026-11-23', end_date: '2026-11-23', days: 0 } }))).status).toBe(422);
  });

  test('rejects a request for more days than the balance (422)', async () => {
    const result = await submit(payload({ phone_number: '6590000003', fields: { start_date: '2026-11-23', end_date: '2026-11-24', days: 2 } }));
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('insufficient_balance');
    expect((await user('6590000003')).sick_leave_balance).toBe(1);
  });

  test('every call, accepted or rejected, is logged with its full request and response', async () => {
    const good = payload();
    await submit(good);
    await submit(payload({ phone_number: '6599999999' }));
    const state = (await getMockState(env.DB)) as any;
    expect(state.log).toHaveLength(2);
    const [rejected, accepted] = state.log; // newest first
    expect(accepted).toMatchObject({ method: 'POST', path: '/mock-api/transactions', status: 201, idempotency_key: good.reference });
    expect(JSON.parse(accepted.request_json)).toEqual(good);
    expect(JSON.parse(accepted.response_json).reference_no).toBe('HR-000001');
    expect(rejected.status).toBe(404);
    expect(state.records).toHaveLength(1);
    expect(state.users).toHaveLength(3);
  });
});
