// The tools Claude can call: reason validation, the draft state machine,
// and the confirmation gate. Claude is not involved; the tools are called
// directly, exactly as the orchestrator calls them.

import { beforeEach, describe, expect, test } from 'vitest';
import { buildTools, executeTool, type ToolContext } from '../src/claude/tools';
import { getOrCreateConversation } from '../src/conversations-repo';
import { createDraft, getOpenDraft, type Draft } from '../src/drafts-repo';
import { loadActiveKb } from '../src/kb-repo';
import { storeEvidence } from '../src/media';
import { createTestEnv, PNG_BYTES, type TestEnv } from './helpers';

let env: TestEnv;
let ctx: ToolContext;

async function call(name: string, input: Record<string, unknown> = {}) {
  const result = await executeTool(ctx, name, input);
  return { ...JSON.parse(result.content), isError: result.isError } as Record<string, any>;
}
const draft = async () => (await getOpenDraft(env.DB, ctx.conversation.id)) as Draft;
const reloadKb = async () => void (ctx.kb = await loadActiveKb(env.DB));

async function uploadEvidence(): Promise<string> {
  const ev = await storeEvidence(env.DB, env.EVIDENCE, {
    conversationId: ctx.conversation.id,
    messageId: null,
    bytes: PNG_BYTES,
    mimeType: 'image/png',
  });
  ctx.newEvidenceIds.add(ev.id);
  return ev.id;
}

const MEDICAL_FIELDS = [
  { name: 'start_date', value: '2026-11-23', status: 'confirmed' },
  { name: 'end_date', value: '2026-11-23', status: 'confirmed' },
  { name: 'days', value: 1, status: 'confirmed' },
  { name: 'clinic', value: 'Sunrise Family Clinic', status: 'confirmed' },
  { name: 'doctor', value: 'Dr Lim', status: 'confirmed' },
];

/** Brings a medical-leave draft to the point where everything is in place. */
async function completeMedicalDraft() {
  await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
  await call('set_reason', { reason_code: 'medical', user_wording: 'down with flu' });
  await call('update_draft_fields', { fields: MEDICAL_FIELDS });
  await call('set_steps', { steps: ['Informed supervisor on the day', 'Got an MC from a registered clinic', 'MC photo sent'] });
  for (const id of ['s1', 's2', 's3']) await call('update_step', { step_id: id, status: 'done', note: 'user confirmed in chat' });
  await call('attach_evidence', { evidence_id: await uploadEvidence(), summary: 'MC from Sunrise Family Clinic', extracted_data: [] });
}

beforeEach(async () => {
  env = createTestEnv();
  ctx = {
    db: env.DB,
    kb: await loadActiveKb(env.DB),
    conversation: await getOrCreateConversation(env.DB, 'mock', '6590000001'),
    newEvidenceIds: new Set(),
    confirmationRequested: false,
  };
});

describe('tool surface', () => {
  test('Claude has no tool that submits', () => {
    const names = buildTools(true).map((t) => t.name);
    expect(names).toEqual([
      'start_or_switch_draft', 'set_reason', 'update_draft_fields', 'add_draft_note', 'set_steps',
      'update_step', 'attach_evidence', 'request_confirmation', 'cancel_draft',
    ]);
    expect(names.some((n) => /submit|send|approve/.test(n))).toBe(false);
  });
  test('an invented tool name is refused', async () => {
    expect((await call('submit_draft')).isError).toBe(true);
  });
  test('tool definitions are identical on every call (they are part of the cached prefix)', () => {
    expect(JSON.stringify(buildTools(true))).toBe(JSON.stringify(buildTools(true)));
  });
});

describe('transaction types and reasons', () => {
  test('only active KB transaction types can be started', async () => {
    expect((await call('start_or_switch_draft', { transaction_type_key: 'expense_claim' })).isError).toBe(true);
    await env.DB.prepare('UPDATE kb_transaction_types SET is_active = 0').run();
    await reloadKb();
    expect((await call('start_or_switch_draft', { transaction_type_key: 'leave_application' })).isError).toBe(true);
    expect(await draft()).toBeNull();
  });

  test('unknown reason codes are rejected', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    const result = await call('set_reason', { reason_code: 'compassionate', user_wording: 'funeral' });
    expect(result.isError).toBe(true);
    expect(result.allowed_reasons.map((r: any) => r.reason_code)).toEqual(['medical', 'supervisor_granted_off', 'no_pay_leave', 'others']);
    expect((await draft()).reason_code).toBeNull();
  });

  test('inactive reason codes are rejected', async () => {
    await env.DB.prepare(`UPDATE kb_reasons SET is_active = 0 WHERE code = 'no_pay_leave'`).run();
    await reloadKb();
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    expect((await call('set_reason', { reason_code: 'no_pay_leave', user_wording: 'unpaid' })).isError).toBe(true);
  });

  test("a valid reason is stored with the user's own wording, and switches the evidence rule and extra fields", async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    const medical = await call('set_reason', { reason_code: 'medical', user_wording: 'I have a fever' });
    expect(medical).toMatchObject({ ok: true, evidence: 'required', max_days: 14 });
    expect(medical.fields_to_collect.map((f: any) => f.name)).toContain('clinic');
    expect(await draft()).toMatchObject({ reason_code: 'medical', user_wording: 'I have a fever' });

    await call('update_draft_fields', { fields: [{ name: 'clinic', value: 'Sunrise', status: 'confirmed' }] });
    await call('set_steps', { steps: ['Got an MC'] });
    const others = await call('set_reason', { reason_code: 'others', user_wording: 'moving house' });
    expect(others).toMatchObject({ ok: true, evidence: 'optional', max_days: null });
    const d = await draft();
    expect(d.steps).toEqual([]); // checklist replaced when the reason changes
    expect(d.fields.clinic).toBeUndefined(); // the old reason's extra field is gone...
    expect(d.notes.map((n) => n.text).join(' ')).toMatch(/clinic/); // ...but kept as a note
  });

  test('a reason a business user adds in the KB is accepted straight away', async () => {
    await env.DB.prepare(
      `INSERT INTO kb_reasons (type_id, code, label, process_guide, evidence_rule, sort_order) VALUES (1, 'childcare_leave', 'Childcare leave', 'Tell your supervisor.', 'none', 40)`,
    ).run();
    await reloadKb();
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    expect((await call('set_reason', { reason_code: 'childcare_leave', user_wording: 'my son is ill' })).ok).toBe(true);
  });
});

describe('draft fields', () => {
  beforeEach(async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    await call('set_reason', { reason_code: 'medical', user_wording: 'flu' });
  });

  test('confirmed values are validated; errors are returned and the bad value is not saved', async () => {
    const result = await call('update_draft_fields', {
      fields: [
        { name: 'start_date', value: '23 Nov', status: 'confirmed' },
        { name: 'days', value: 1, status: 'confirmed' },
        { name: 'employee_id', value: 'E123', status: 'confirmed' },
      ],
    });
    expect(result.saved).toEqual(['days']);
    expect(result.errors).toHaveLength(2);
    expect((await draft()).fields).toEqual({ days: { value: 1, status: 'confirmed' } });
  });

  test('partial or uncertain values can be kept as unconfirmed', async () => {
    await call('update_draft_fields', { fields: [{ name: 'start_date', value: 'sometime last week', status: 'unconfirmed' }] });
    expect((await draft()).fields.start_date).toEqual({ value: 'sometime last week', status: 'unconfirmed' });
  });

  test('notes are stored on the draft', async () => {
    await call('add_draft_note', { text: 'supervisor will confirm tomorrow' });
    expect((await draft()).notes.map((n) => n.text)).toEqual(['supervisor will confirm tomorrow']);
  });
});

describe('confirmation gate', () => {
  test('is refused without a reason', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed.join(' ')).toMatch(/No reason has been set/);
  });

  test('is refused while a required field is unconfirmed', async () => {
    await completeMedicalDraft();
    await call('update_draft_fields', { fields: [{ name: 'end_date', value: '2026-11-23', status: 'unconfirmed' }] });
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed).toEqual(['Not yet confirmed with the user: Last day of leave (end_date)']);
    expect((await draft()).status).toBe('collecting');
  });

  test('is refused while a required field is missing', async () => {
    await completeMedicalDraft();
    await call('update_draft_fields', { fields: [{ name: 'doctor', value: null, status: 'confirmed' }] });
    expect((await call('request_confirmation')).still_needed).toEqual(['Missing: Doctor (doctor)']);
  });

  test('is refused when there is no checklist', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    await call('set_reason', { reason_code: 'others', user_wording: 'moving house' });
    await call('update_draft_fields', {
      fields: [...MEDICAL_FIELDS.slice(0, 3), { name: 'reason_description', value: 'Moving house', status: 'confirmed' }],
    });
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed).toEqual(['No checklist yet (use set_steps to build it from the process guide).']);
  });

  test.each(['not_done', 'unknown'])('is refused while a step is %s', async (status) => {
    await completeMedicalDraft();
    await call('update_step', { step_id: 's1', status, note: 'not yet' });
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed.join(' ')).toMatch(/Step s1 is not done yet/);
  });

  test('a not-applicable step needs a note saying why, then it passes', async () => {
    await completeMedicalDraft();
    expect((await call('update_step', { step_id: 's1', status: 'not_applicable', note: '' })).isError).toBe(true);
    await call('update_step', { step_id: 's1', status: 'not_applicable', note: 'user is the supervisor' });
    expect((await call('request_confirmation')).ok).toBe(true);
  });

  test('required evidence must be attached', async () => {
    await completeMedicalDraft();
    await env.DB.prepare('UPDATE evidence SET draft_id = NULL').run();
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed.join(' ')).toMatch(/Evidence is required for "Medical leave"/);
  });

  test('optional evidence is not needed', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    await call('set_reason', { reason_code: 'others', user_wording: 'moving house' });
    await call('update_draft_fields', {
      fields: [...MEDICAL_FIELDS.slice(0, 3), { name: 'reason_description', value: 'Moving house', status: 'confirmed' }],
    });
    await call('set_steps', { steps: ['Described the reason'] });
    await call('update_step', { step_id: 's1', status: 'done', note: 'user described it in chat' });
    expect((await call('request_confirmation')).ok).toBe(true);
  });

  test("the reason's maximum number of days is enforced", async () => {
    await completeMedicalDraft();
    await call('update_draft_fields', {
      fields: [
        { name: 'end_date', value: '2026-12-31', status: 'confirmed' },
        { name: 'days', value: 15, status: 'confirmed' },
      ],
    });
    const result = await call('request_confirmation');
    expect(result.isError).toBe(true);
    expect(result.still_needed.join(' ')).toMatch(/over the limit of 14 day/);
  });

  test('passes when everything is in place, and moves the draft to awaiting_confirmation', async () => {
    await completeMedicalDraft();
    expect((await draft()).status).toBe('collecting');
    expect((await call('request_confirmation')).ok).toBe(true);
    expect((await draft()).status).toBe('awaiting_confirmation');
    expect(ctx.confirmationRequested).toBe(true);
  });

  test.each([
    ['a field change', () => call('update_draft_fields', { fields: [{ name: 'days', value: 0.5, status: 'confirmed' }] })],
    ['a reason change', () => call('set_reason', { reason_code: 'others', user_wording: 'actually something else' })],
    ['a checklist change', () => call('update_step', { step_id: 's2', status: 'not_done', note: 'no MC yet' })],
    ['new evidence', async () => call('attach_evidence', { evidence_id: await uploadEvidence(), summary: 'another photo', extracted_data: [] })],
  ])('%s after confirmation was requested sends the draft back to collecting', async (_name, change) => {
    await completeMedicalDraft();
    await call('request_confirmation');
    await change();
    expect((await draft()).status).toBe('collecting');
    expect(ctx.confirmationRequested).toBe(false);
  });
});

describe('one open draft per user', () => {
  test('the database refuses a second open draft for the same conversation', async () => {
    const args = { conversationId: ctx.conversation.id, phoneNumber: '6590000001', typeId: 1, typeKey: 'leave_application' };
    await createDraft(env.DB, args);
    await expect(createDraft(env.DB, args)).rejects.toThrow();
  });
  test('starting the same type again continues the open draft', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    const first = (await draft()).id;
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    expect((await draft()).id).toBe(first);
  });
  test('cancel_draft closes it', async () => {
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    await call('cancel_draft');
    expect(await draft()).toBeNull();
  });
});

describe('evidence', () => {
  test("a file from another user's conversation cannot be attached", async () => {
    const other = await getOrCreateConversation(env.DB, 'mock', '6590000002');
    const foreign = await storeEvidence(env.DB, env.EVIDENCE, { conversationId: other.id, messageId: null, bytes: PNG_BYTES, mimeType: 'image/png' });
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    expect((await call('attach_evidence', { evidence_id: foreign.id, summary: 'x', extracted_data: [] })).isError).toBe(true);
  });

  test('the reading is saved even before a draft exists, and kept when the file is linked later', async () => {
    const id = await uploadEvidence();
    const first = await call('attach_evidence', { evidence_id: id, summary: 'MC for 23 Nov', extracted_data: [{ name: 'clinic', value: 'Sunrise' }] });
    expect(first).toMatchObject({ ok: true, attached: false, reading: 'saved' });

    ctx.newEvidenceIds.clear(); // a later turn: the file is no longer visible to Claude
    await call('start_or_switch_draft', { transaction_type_key: 'leave_application' });
    const later = await call('attach_evidence', { evidence_id: id, summary: 'something made up', extracted_data: [] });
    expect(later).toMatchObject({ ok: true, attached: true });
    const row = await env.DB.prepare('SELECT summary, draft_id FROM evidence WHERE id = ?').bind(id).first<any>();
    expect(row.summary).toBe('MC for 23 Nov');
    expect(row.draft_id).toBe((await draft()).id);
  });
});
