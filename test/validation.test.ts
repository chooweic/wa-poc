import { describe, expect, test } from 'vitest';
import type { Draft } from '../src/drafts-repo';
import { loadActiveKb } from '../src/kb-repo';
import { checkFieldValue, checkSchemaText, effectiveFields, fieldProblems } from '../src/validation';
import { createTestDb } from './helpers';

async function leave() {
  const kb = await loadActiveKb(createTestDb());
  const type = kb.types[0];
  const reason = (code: string) => type.reasons.find((r) => r.code === code)!;
  return { type, reason };
}

function draftWith(fields: Record<string, unknown>): Draft {
  return {
    fields: Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, status: 'confirmed' as const }])),
    steps: [],
    notes: [],
  } as unknown as Draft;
}

describe('schema validation of field values', () => {
  test('the reason adds its extra fields to the type fields', async () => {
    const { type, reason } = await leave();
    expect(effectiveFields(type, null).map((f) => f.name)).toEqual(['start_date', 'end_date', 'days']);
    expect(effectiveFields(type, reason('medical')).map((f) => f.name)).toEqual(['start_date', 'end_date', 'days', 'clinic', 'doctor', 'mc_number']);
    expect(effectiveFields(type, reason('others')).map((f) => f.name)).toContain('reason_description');
  });

  test('dates must be real calendar dates in YYYY-MM-DD', async () => {
    const { type } = await leave();
    const start = effectiveFields(type, null)[0];
    expect(checkFieldValue(start, '2026-11-23')).toEqual({ ok: true, value: '2026-11-23' });
    for (const bad of ['23/11/2026', '2026-02-30', 'yesterday', 20261123, '']) {
      expect(checkFieldValue(start, bad).ok, String(bad)).toBe(false);
    }
  });

  test('days must be a number above zero; numeric strings are accepted', async () => {
    const { type } = await leave();
    const days = effectiveFields(type, null)[2];
    expect(checkFieldValue(days, 0.5)).toEqual({ ok: true, value: 0.5 });
    expect(checkFieldValue(days, '2')).toEqual({ ok: true, value: 2 });
    expect(checkFieldValue(days, 0).ok).toBe(false);
    expect(checkFieldValue(days, -1).ok).toBe(false);
    expect(checkFieldValue(days, 'two').ok).toBe(false);
  });

  test('cross-field checks: order of dates, days within the period, per-reason limit', async () => {
    const { type, reason } = await leave();
    const ok = draftWith({ start_date: '2026-11-23', end_date: '2026-11-24', days: 2, clinic: 'A', doctor: 'B' });
    expect(fieldProblems(ok, type, reason('medical'))).toEqual([]);

    const backwards = draftWith({ start_date: '2026-11-24', end_date: '2026-11-23', days: 1, clinic: 'A', doctor: 'B' });
    expect(fieldProblems(backwards, type, reason('medical')).join(' ')).toMatch(/before the first day/);

    const tooMany = draftWith({ start_date: '2026-11-23', end_date: '2026-11-24', days: 3, clinic: 'A', doctor: 'B' });
    expect(fieldProblems(tooMany, type, reason('medical')).join(' ')).toMatch(/more than the 2 calendar day/);

    const overLimit = draftWith({ start_date: '2026-11-02', end_date: '2026-11-13', days: 6, supervisor_name: 'S', approval_date: '2026-11-01' });
    expect(fieldProblems(overLimit, type, reason('no_pay_leave')).join(' ')).toMatch(/over the limit of 5 day/);
  });
});

describe('Technical tab JSON check', () => {
  test('accepts a sensible schema and rejects broken ones', () => {
    expect(checkSchemaText('{"type":"object","properties":{"a_b":{"type":"string"}},"required":["a_b"]}')).toBeNull();
    expect(checkSchemaText('{not json')).toMatch(/Not valid JSON/);
    expect(checkSchemaText('[]')).toMatch(/JSON object/);
    expect(checkSchemaText('{"properties":{"Bad Name":{}}}')).toMatch(/lower_snake_case/);
    expect(checkSchemaText('{"properties":{},"required":["missing"]}')).toMatch(/not in "properties"/);
  });
});
