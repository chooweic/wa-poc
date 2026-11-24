// Validation that the CODE enforces (never left to the model):
//  - field values against the KB's JSON Schemas
//  - per-reason limits and evidence rules
//  - the confirmation gate: what must be true before a draft may be confirmed

import { Validator } from '@cfworker/json-schema';
import type { Draft, EvidenceRecord, FieldEntry } from './drafts-repo';
import type { KbReason, KbTransactionType } from './kb-repo';
import { safeJsonParse } from './util';

export interface FieldSpec {
  name: string;
  title: string;
  description: string;
  required: boolean;
  /** The JSON Schema for this one property. */
  schema: Record<string, unknown>;
}

interface ObjectSchema {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

function specsFrom(schemaText: string | null | undefined): FieldSpec[] {
  const schema = safeJsonParse<ObjectSchema>(schemaText, {});
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    title: typeof prop.title === 'string' ? prop.title : name,
    description: typeof prop.description === 'string' ? prop.description : '',
    required: required.has(name),
    schema: prop,
  }));
}

/** The fields a draft collects: the transaction type's fields, then the chosen reason's extra fields. */
export function effectiveFields(type: KbTransactionType, reason: KbReason | null): FieldSpec[] {
  const base = specsFrom(type.fields_schema);
  const names = new Set(base.map((f) => f.name));
  const extra = reason ? specsFrom(reason.extra_fields_schema).filter((f) => !names.has(f.name)) : [];
  return [...base, ...extra];
}

/** Checks text typed into the Technical tab. Returns an error message, or null when it is acceptable. */
export function checkSchemaText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `Not valid JSON: ${(e as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Must be a JSON object.';
  const schema = parsed as ObjectSchema;
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) {
      return '"properties" must be an object.';
    }
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) return `Field name "${name}" must be lower_snake_case.`;
      if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) return `Field "${name}" must be an object.`;
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) {
      return '"required" must be a list of field names.';
    }
    const missing = schema.required.filter((r) => !schema.properties || !(r in schema.properties));
    if (missing.length) return `"required" lists fields that are not in "properties": ${missing.join(', ')}`;
  }
  return null;
}

// ------------------------------------------------------------ field values

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Turns "2" into 2 for number fields and 2 into "2" for string fields, so trivial type slips are not errors. */
function coerce(spec: FieldSpec, value: unknown): unknown {
  const type = spec.schema.type;
  if ((type === 'number' || type === 'integer') && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  if (type === 'string' && typeof value === 'string') return value.trim();
  return value;
}

export type FieldCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** Validates one value against its field's JSON Schema. */
export function checkFieldValue(spec: FieldSpec, rawValue: unknown): FieldCheck {
  const value = coerce(spec, rawValue);
  if (value === '' || value === null || value === undefined) {
    return { ok: false, error: `${spec.name}: a value is needed` };
  }
  if (spec.schema.format === 'date' && (typeof value !== 'string' || !isRealDate(value))) {
    return { ok: false, error: `${spec.name}: must be a real calendar date written as YYYY-MM-DD` };
  }
  const result = new Validator(spec.schema as never, '2020-12', false).validate(value);
  if (!result.valid) {
    const detail = result.errors
      .map((e) => e.error)
      .filter(Boolean)
      .slice(0, 2)
      .join('; ');
    return { ok: false, error: `${spec.name}: ${detail || 'value does not match what is expected'}` };
  }
  return { ok: true, value };
}

function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function confirmedValue(draft: Draft, name: string): unknown {
  const entry: FieldEntry | undefined = draft.fields[name];
  return entry && entry.status === 'confirmed' ? entry.value : undefined;
}

/**
 * Problems with the collected fields. By convention the fields `start_date`,
 * `end_date` and `days` get consistency checks, and a reason's `max_days`
 * limit applies to `days`.
 */
export function fieldProblems(draft: Draft, type: KbTransactionType, reason: KbReason | null): string[] {
  const problems: string[] = [];
  for (const spec of effectiveFields(type, reason)) {
    const entry = draft.fields[spec.name];
    if (!entry) {
      if (spec.required) problems.push(`Missing: ${spec.title} (${spec.name})`);
      continue;
    }
    if (entry.status !== 'confirmed') {
      if (spec.required) problems.push(`Not yet confirmed with the user: ${spec.title} (${spec.name})`);
      continue;
    }
    const check = checkFieldValue(spec, entry.value);
    if (!check.ok) problems.push(`Invalid: ${check.error}`);
  }

  const start = confirmedValue(draft, 'start_date');
  const end = confirmedValue(draft, 'end_date');
  const days = confirmedValue(draft, 'days');
  if (typeof start === 'string' && typeof end === 'string' && isRealDate(start) && isRealDate(end)) {
    if (end < start) {
      problems.push('The last day of leave (end_date) is before the first day (start_date).');
    } else if (typeof days === 'number' && days > daysBetweenInclusive(start, end)) {
      problems.push(
        `The number of days (${days}) is more than the ${daysBetweenInclusive(start, end)} calendar day(s) between start_date and end_date.`,
      );
    }
  }
  if (reason?.max_days != null && typeof days === 'number' && days > reason.max_days) {
    problems.push(
      `${days} day(s) is over the limit of ${reason.max_days} day(s) for "${reason.label}". This limit cannot be overridden here.`,
    );
  }
  return problems;
}

// ------------------------------------------------------- confirmation gate

export interface GateInput {
  draft: Draft;
  /** The draft's transaction type, or null when it is no longer active in the KB. */
  type: KbTransactionType | null;
  /** The draft's reason, or null when none is set or it is no longer active in the KB. */
  reason: KbReason | null;
  evidence: EvidenceRecord[];
}

/**
 * Everything that still blocks confirmation. An empty list means the draft
 * may move to `awaiting_confirmation`. This is also re-checked at the moment
 * the user replies YES.
 */
export function confirmationBlockers({ draft, type, reason, evidence }: GateInput): string[] {
  if (!type) return ['This transaction type is no longer available.'];
  const problems: string[] = [];

  if (!draft.reason_code) {
    problems.push('No reason has been set (use set_reason).');
  } else if (!reason) {
    problems.push(`The reason "${draft.reason_code}" is not an active reason for this transaction type. Choose another.`);
  }

  problems.push(...fieldProblems(draft, type, reason));

  if (reason?.evidence_rule === 'required' && evidence.length === 0) {
    problems.push(`Evidence is required for "${reason.label}" and none is attached yet (use attach_evidence).`);
  }

  if (draft.steps.length === 0) {
    problems.push('No checklist yet (use set_steps to build it from the process guide).');
  }
  for (const step of draft.steps) {
    if (step.status === 'not_applicable') {
      if (!step.note.trim()) problems.push(`Step ${step.id} is marked not applicable but has no note explaining why.`);
    } else if (step.status !== 'done') {
      problems.push(`Step ${step.id} is not done yet ("${step.text}", currently ${step.status}).`);
    }
  }
  return problems;
}
