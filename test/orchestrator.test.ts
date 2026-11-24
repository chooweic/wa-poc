// Whole turns through the real simulator route, queue consumer and
// orchestrator, with a scripted stand-in for Claude.
//
// The most important tests in the project are here: a request is submitted
// ONLY when the user's own message is "YES" while the draft is awaiting
// confirmation.

import { beforeEach, describe, expect, test } from 'vitest';
import type { ClaudeRequest } from '../src/claude/client';
import { seedMockData } from '../src/mock-app/seed';
import { callTools, createDeps, createTestEnv, PNG_BYTES, say, ScriptedClaude, sendViaSimulator, type TestEnv } from './helpers';

const PHONE = '6590000001'; // Aisha Rahman in the demo data
const MC_PHOTO = { bytes: PNG_BYTES, type: 'image/png', name: 'mc.png' };

let env: TestEnv;
beforeEach(async () => {
  env = createTestEnv();
  await seedMockData(env);
});

const records = async () => (await env.DB.prepare('SELECT * FROM mock_leave_records').all<any>()).results;
const apiCalls = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_api_log').first<{ n: number }>())!.n;
const openDraft = async () =>
  env.DB.prepare(`SELECT * FROM drafts WHERE status IN ('collecting', 'awaiting_confirmation')`).first<any>();
const lastDraft = async () => env.DB.prepare('SELECT * FROM drafts ORDER BY updated_at DESC, rowid DESC').first<any>();
const evidenceId = async () => (await env.DB.prepare('SELECT id FROM evidence ORDER BY created_at DESC').first<{ id: string }>())!.id;

/** Scripted Claude turn that files a complete medical-leave request from one message with an MC photo. */
function fileMedicalLeave(): ScriptedClaude {
  return new ScriptedClaude([
    callTools(['start_or_switch_draft', { transaction_type_key: 'leave_application' }]),
    callTools(['set_reason', { reason_code: 'medical', user_wording: 'I was sick yesterday' }]),
    () =>
      callTools(
        ['update_draft_fields', {
          fields: [
            { name: 'start_date', value: '2026-11-23', status: 'confirmed' },
            { name: 'end_date', value: '2026-11-23', status: 'confirmed' },
            { name: 'days', value: 1, status: 'confirmed' },
            { name: 'clinic', value: 'Sunrise Family Clinic', status: 'confirmed' },
            { name: 'doctor', value: 'Dr Lim', status: 'confirmed' },
          ],
        }],
        ['set_steps', { steps: ['Informed supervisor on the day', 'Got an MC from a registered clinic', 'MC photo sent within 2 working days'] }],
      ),
    async () => {
      const row = await env.DB.prepare('SELECT id FROM evidence ORDER BY created_at DESC').first<{ id: string }>();
      return callTools(
        ['update_step', { step_id: 's1', status: 'done', note: 'user confirmed in chat' }],
        ['update_step', { step_id: 's2', status: 'done', note: 'seen on MC' }],
        ['update_step', { step_id: 's3', status: 'done', note: 'photo received' }],
        ['attach_evidence', { evidence_id: row!.id, summary: 'MC from Sunrise Family Clinic for 23 Nov 2026', extracted_data: [{ name: 'clinic', value: 'Sunrise Family Clinic' }] }],
      );
    },
    callTools(['request_confirmation', {}]),
    say('Please check the details below.'),
  ]);
}

/** Gets a draft to `awaiting_confirmation` and returns the replies of that turn. */
async function reachConfirmation(phone = PHONE): Promise<string[]> {
  return sendViaSimulator(env, createDeps(env, fileMedicalLeave()), phone, 'I was sick yesterday, here is my MC', MC_PHOTO);
}

describe('confirmation gating: no submission without the user saying YES', () => {
  test('the backend sends the summary; nothing is submitted yet', async () => {
    const replies = await reachConfirmation();
    expect(replies).toHaveLength(2);
    expect(replies[0]).toBe('Please check the details below.');
    expect(replies[1]).toMatch(/\*Please check your request\*/);
    expect(replies[1]).toMatch(/Medical leave/);
    expect(replies[1]).toMatch(/First day of leave: 2026-11-23 \(Mon\)/);
    expect(replies[1]).toMatch(/✅ Informed supervisor on the day \(user confirmed in chat\)/);
    expect(replies[1]).toMatch(/Reply \*YES\* to submit/);
    expect((await openDraft()).status).toBe('awaiting_confirmation');
    expect(await records()).toHaveLength(0);
    expect(await apiCalls()).toBe(0);
  });

  test.each(['ok', 'yes please', 'yes.', 'yep', 'go ahead and submit it', 'y'])(
    'the message %j does not submit (it goes to Claude instead)',
    async (text) => {
      await reachConfirmation();
      const claude = new ScriptedClaude([say('Please reply with just YES to submit.')]);
      const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, text);
      expect(replies).toEqual(['Please reply with just YES to submit.']);
      expect(claude.requests).toHaveLength(1);
      expect(await records()).toHaveLength(0);
      expect((await openDraft()).status).toBe('awaiting_confirmation');
    },
  );

  test.each(['YES', 'yes', '  Yes  ', 'yEs\n'])('the message %j submits, without calling Claude', async (text) => {
    await reachConfirmation();
    const claude = new ScriptedClaude([]); // would throw if called
    const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, text);
    expect(claude.requests).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/Submitted\. Your reference number is \*HR-000001\*/);

    const [record] = await records();
    expect(record).toMatchObject({ phone_number: PHONE, reason_code: 'medical', status: 'approved', days: 1, start_date: '2026-11-23' });
    const user = await env.DB.prepare('SELECT sick_leave_balance FROM mock_users WHERE phone_number = ?').bind(PHONE).first<any>();
    expect(user.sick_leave_balance).toBe(13);
    expect(await lastDraft()).toMatchObject({ status: 'submitted', target_reference: 'HR-000001' });
    expect(await openDraft()).toBeNull();
  });

  test('YES when nothing is awaiting confirmation is just chat', async () => {
    const claude = new ScriptedClaude([say('Yes to what? How can I help?')]);
    const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, 'YES');
    expect(replies).toEqual(['Yes to what? How can I help?']);
    expect(await apiCalls()).toBe(0);
  });

  test('YES while the draft is still collecting does not submit', async () => {
    await reachConfirmation();
    // The user changes something, which sends the draft back to collecting...
    const change = new ScriptedClaude([
      callTools(['update_draft_fields', { fields: [{ name: 'days', value: 0.5, status: 'confirmed' }] }]),
      say('Changed to half a day.'),
    ]);
    await sendViaSimulator(env, createDeps(env, change), PHONE, 'actually it was half a day');
    expect((await openDraft()).status).toBe('collecting');
    // ...so YES now reaches Claude and nothing is submitted.
    const claude = new ScriptedClaude([say('Let me send you the updated summary first.')]);
    await sendViaSimulator(env, createDeps(env, claude), PHONE, 'YES');
    expect(claude.requests).toHaveLength(1);
    expect(await records()).toHaveLength(0);
  });

  test('YES as the caption of a photo does not submit', async () => {
    await reachConfirmation();
    const claude = new ScriptedClaude([
      async () => callTools(['attach_evidence', { evidence_id: await evidenceId(), summary: 'another photo', extracted_data: [] }]),
      say('Got another photo.'),
    ]);
    await sendViaSimulator(env, createDeps(env, claude), PHONE, 'YES', MC_PHOTO);
    expect(await records()).toHaveLength(0);
  });

  test('a second YES cannot submit the same request twice', async () => {
    await reachConfirmation();
    await sendViaSimulator(env, createDeps(env, new ScriptedClaude([])), PHONE, 'YES');
    const claude = new ScriptedClaude([say('That request is already submitted.')]);
    await sendViaSimulator(env, createDeps(env, claude), PHONE, 'YES');
    expect(await records()).toHaveLength(1);
    expect(await apiCalls()).toBe(1);
  });

  test('the gate is re-checked at YES: a reason deactivated after the summary blocks submission', async () => {
    await reachConfirmation();
    await env.DB.prepare(`UPDATE kb_reasons SET is_active = 0 WHERE code = 'medical'`).run();
    const replies = await sendViaSimulator(env, createDeps(env, new ScriptedClaude([])), PHONE, 'YES');
    expect(replies[0]).toMatch(/couldn't submit/);
    expect(await records()).toHaveLength(0);
    expect(await apiCalls()).toBe(0);
    expect((await openDraft()).status).toBe('collecting');
  });
});

describe('submission results', () => {
  test('an unknown phone number gets a plain-language error and the draft is marked failed', async () => {
    const stranger = '6591112222';
    await reachConfirmation(stranger);
    const replies = await sendViaSimulator(env, createDeps(env, new ScriptedClaude([])), stranger, 'yes');
    expect(replies[0]).toMatch(/your phone number isn't registered in the HR system/);
    expect(await records()).toHaveLength(0);
    expect((await lastDraft()).status).toBe('failed');
  });

  test('not enough balance reopens the draft so the user can change it', async () => {
    await env.DB.prepare('UPDATE mock_users SET sick_leave_balance = 0 WHERE phone_number = ?').bind(PHONE).run();
    await reachConfirmation();
    const replies = await sendViaSimulator(env, createDeps(env, new ScriptedClaude([])), PHONE, 'yes');
    expect(replies[0]).toMatch(/Not enough medical leave balance/);
    expect((await openDraft()).status).toBe('collecting');
  });

  test('a target system that is down keeps the draft awaiting, and a later YES succeeds', async () => {
    await reachConfirmation();
    const deps = createDeps(env, new ScriptedClaude([]));
    const working = deps.target;
    deps.target = { submit: async () => ({ ok: false, status: 0, errorCode: 'unreachable', errorMessage: 'down', retryable: true }) };
    const failed = await sendViaSimulator(env, deps, PHONE, 'yes');
    expect(failed[0]).toMatch(/Reply \*YES\* to try again/);
    expect((await openDraft()).status).toBe('awaiting_confirmation');
    deps.target = working;
    const retried = await sendViaSimulator(env, deps, PHONE, 'yes');
    expect(retried[0]).toMatch(/Submitted/);
    expect(await records()).toHaveLength(1);
  });
});

describe('commands', () => {
  test('/cancel cancels the open draft without calling Claude', async () => {
    await reachConfirmation();
    const claude = new ScriptedClaude([]);
    const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, ' /CANCEL ');
    expect(replies[0]).toMatch(/cancelled/);
    expect(await openDraft()).toBeNull();
    expect((await lastDraft()).status).toBe('cancelled');
    expect(await sendViaSimulator(env, createDeps(env, claude), PHONE, '/cancel')).toEqual(["There's no request in progress to cancel."]);
  });

  test('/reset cancels the draft and hides earlier messages from Claude', async () => {
    await reachConfirmation();
    await sendViaSimulator(env, createDeps(env, new ScriptedClaude([])), PHONE, '/reset');
    expect(await openDraft()).toBeNull();
    const claude = new ScriptedClaude([say('Hello! How can I help?')]);
    await sendViaSimulator(env, createDeps(env, claude), PHONE, 'hello again');
    const sent = JSON.stringify(claude.requests[0].messages);
    expect(sent).not.toMatch(/I was sick yesterday/);
    expect(sent).toMatch(/hello again/);
  });
});

describe('what Claude is sent', () => {
  const flat = (request: ClaudeRequest) => JSON.stringify(request.messages);

  test('the cached prefix is byte-identical across turns and everything that changes comes after it', async () => {
    const claude = new ScriptedClaude([say('Hi!'), say('Sure.')]);
    const deps = createDeps(env, claude);
    await sendViaSimulator(env, deps, PHONE, 'hello');
    deps.now = () => new Date('2026-11-25T09:30:00Z');
    await sendViaSimulator(env, deps, '6590000002', 'how do I apply for no pay leave?');
    const [a, b] = claude.requests;

    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    // One cache marker, at the end of the KB, with the 1-hour lifetime.
    expect(a.system.map((s) => s.cache_control)).toEqual([undefined, { type: 'ephemeral', ttl: '1h' }]);
    const prefix = JSON.stringify(a.tools) + JSON.stringify(a.system);
    for (const volatile of [PHONE, '2026-11-24', 'hello', 'Aisha']) expect(prefix).not.toContain(volatile);
    // Time and user are in the final user turn instead.
    expect(flat(a)).toMatch(/Current date and time: Tuesday 2026-11-24, 10:00 \(Asia\/Singapore\)/);
    expect(flat(a)).toContain(`User's WhatsApp number (their ID, already known): ${PHONE}`);
  });

  test('a KB edit changes the prompt on the next message, with no redeploy', async () => {
    const claude = new ScriptedClaude([say('one'), say('two')]);
    const deps = createDeps(env, claude);
    await sendViaSimulator(env, deps, PHONE, 'hello');
    await env.DB.prepare(`UPDATE kb_reasons SET process_guide = 'Send the MC within 5 working days.' WHERE code = 'medical'`).run();
    await sendViaSimulator(env, deps, PHONE, 'hello again');
    expect(JSON.stringify(claude.requests[0].system)).not.toContain('within 5 working days');
    expect(JSON.stringify(claude.requests[1].system)).toContain('within 5 working days');
  });

  test('an image is sent to Claude only on the turn it arrives; later turns get the recorded text', async () => {
    const first = new ScriptedClaude([
      async () => callTools(['attach_evidence', { evidence_id: await evidenceId(), summary: 'MC from Sunrise Family Clinic for 23 Nov', extracted_data: [{ name: 'doctor', value: 'Dr Lim' }] }]),
      say('Thanks, I can see your MC.'),
    ]);
    await sendViaSimulator(env, createDeps(env, first), PHONE, 'here is my MC', MC_PHOTO);
    expect(flat(first.requests[0])).toContain('"type":"image"');
    expect(flat(first.requests[0])).toMatch(/ARRIVED WITH THIS MESSAGE/);

    const second = new ScriptedClaude([say('Which dates were you away?')]);
    await sendViaSimulator(env, createDeps(env, second), PHONE, 'I want to apply for leave');
    const later = flat(second.requests[0]);
    expect(later).not.toContain('"type":"image"');
    expect(later).not.toContain('base64');
    expect(later).toContain('MC from Sunrise Family Clinic for 23 Nov');
    expect(later).toContain('doctor: Dr Lim');
    expect(later).toMatch(/The user sent a photo \(evidence_id [0-9a-f-]{36}\)/);
  });

  test('if a new file was not recorded, Claude is asked once more before the reply is sent', async () => {
    const claude = new ScriptedClaude([
      say('Thanks!'),
      async () => callTools(['attach_evidence', { evidence_id: await evidenceId(), summary: 'A photo of an MC', extracted_data: [] }]),
      say('Thanks, I have your MC.'),
    ]);
    const replies = await sendViaSimulator(env, createDeps(env, claude), PHONE, '', MC_PHOTO);
    expect(replies).toEqual(['Thanks, I have your MC.']);
    expect((await env.DB.prepare('SELECT summary FROM evidence').first<any>()).summary).toBe('A photo of an MC');
  });

  test('tool results go back to Claude in one user message, and validation errors are reported to it', async () => {
    const claude = new ScriptedClaude([
      callTools(['start_or_switch_draft', { transaction_type_key: 'leave_application' }], ['set_reason', { reason_code: 'holiday', user_wording: 'beach' }]),
      say('Which of these fits: medical leave, an off day from your supervisor, no pay leave, or something else?'),
    ]);
    await sendViaSimulator(env, createDeps(env, claude), PHONE, 'I want to go to the beach');
    const results = claude.requests[1].messages.at(-1)!.content as any[];
    expect(results.map((r) => r.type)).toEqual(['tool_result', 'tool_result']);
    expect(results[0].is_error).toBe(false);
    expect(results[1].is_error).toBe(true);
    expect(results[1].content).toMatch(/not an allowed reason/);
  });
});

describe('without Claude or with unusable input', () => {
  test('a missing API key gives a clear message instead of an error', async () => {
    const replies = await sendViaSimulator(env, createDeps(env, null), PHONE, 'hello');
    expect(replies[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  test('oversized and unsupported files are rejected with a friendly message and never stored', async () => {
    const claude = new ScriptedClaude([]);
    const big = { bytes: new ArrayBuffer(6 * 1024 * 1024), type: 'image/png', name: 'huge.png' };
    expect((await sendViaSimulator(env, createDeps(env, claude), PHONE, '', big))[0]).toMatch(/too large \(the limit is 5 MB\)/);
    const gif = { bytes: PNG_BYTES, type: 'image/gif', name: 'funny.gif' };
    expect((await sendViaSimulator(env, createDeps(env, claude), PHONE, '', gif))[0]).toMatch(/can't read that kind of file/);
    expect((env.EVIDENCE as any).store.size).toBe(0);
    expect(claude.requests).toHaveLength(0);
  });
});
