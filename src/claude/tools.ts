// The tools Claude may call, and the code that runs them.
//
// Every input is validated here: the model's output is never trusted. There
// is deliberately NO tool that submits a request; submission happens only in
// the orchestrator when the user's own message is "YES".

import type { Conversation } from '../conversations-repo';
import {
  createDraft,
  getEvidence,
  getOpenDraft,
  linkEvidence,
  listDraftEvidence,
  saveDraft,
  saveEvidenceReading,
  unlinkDraftEvidence,
  type Draft,
  type DraftStep,
  type StepStatus,
} from '../drafts-repo';
import type { ActiveKb, KbReason, KbTypeWithReasons } from '../kb-repo';
import { checkFieldValue, confirmationBlockers, effectiveFields } from '../validation';
import type { ClaudeTool } from './client';

// ------------------------------------------------------------ definitions
// Kept in a fixed order and free of anything that varies per request, so
// they stay part of the cached prefix.

const noInput = { type: 'object' as const, properties: {}, required: [], additionalProperties: false };

const TOOL_DEFINITIONS: ClaudeTool[] = [
  {
    name: 'start_or_switch_draft',
    description:
      "Open a request (draft) for a transaction type from the knowledge base. Call this as soon as it is clear which transaction the user wants. If a draft of the same type is already open it is returned unchanged; if a draft of a different type is open it is cancelled and replaced. Returns the fields to collect and the allowed reasons.",
    input_schema: {
      type: 'object',
      properties: {
        transaction_type_key: {
          type: 'string',
          description: 'The transaction_type_key of an active transaction type in the knowledge base.',
        },
      },
      required: ['transaction_type_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_reason',
    description:
      "Set the reason for the open draft once you are confident which allowed reason fits. Only reason codes listed for the draft's transaction type are accepted. Changing the reason clears the checklist (build a new one with set_steps) and switches the evidence rule and extra fields to the new reason's.",
    input_schema: {
      type: 'object',
      properties: {
        reason_code: { type: 'string', description: "A reason_code listed for the draft's transaction type." },
        user_wording: {
          type: 'string',
          description: "The reason in the user's own words, quoted or closely paraphrased from what they wrote. Kept for audit.",
        },
      },
      required: ['reason_code', 'user_wording'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_draft_fields',
    description:
      'Save one or more details to the open draft. Use the field names listed in the knowledge base for the transaction type and the chosen reason. Dates are YYYY-MM-DD. Give each value a status: "confirmed" when the user stated it clearly or agreed to it, "unconfirmed" when it is partial, inferred or not yet agreed. Confirmed values are validated and any errors are returned so you can ask the user; unconfirmed values are stored as they are. Pass a null value to remove a field.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Field name from the knowledge base.' },
              value: {
                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                description: 'The value. Use a number for numeric fields. Null removes the field.',
              },
              status: { type: 'string', enum: ['confirmed', 'unconfirmed'] },
            },
            required: ['name', 'value', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_draft_note',
    description:
      'Add a short note to the open draft for context that matters but is not a field, for example "supervisor will confirm tomorrow" or a question the process guide does not answer. Notes are shown to you on every turn and to the administrator. They are never sent to the target system.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_steps',
    description:
      "Create or replace the open draft's checklist. Call this once the reason is set: turn the reason's process guide and the transaction type's general guide into a short ordered list of things the user must have done, one short line each, including any deadline that applies. Steps whose wording is unchanged keep their status.",
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'The checklist, in order. Between 1 and 12 short lines.',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_step',
    description:
      'Record the result of checking one checklist step. Use "done" only when the user has said so or the evidence shows it. Use "not_applicable" only when the step genuinely does not apply, and explain why in the note. Always give a short note on how it was verified, for example "user confirmed in chat" or "seen in screenshot".',
    input_schema: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: 'The step id shown in the checklist, for example "s2".' },
        status: { type: 'string', enum: ['done', 'not_done', 'not_applicable', 'unknown'] },
        note: { type: 'string', description: 'How this was verified, or why the step does not apply.' },
      },
      required: ['step_id', 'status', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_evidence',
    description:
      'Record what an uploaded photo or PDF shows and link it to the open draft. Call this on the turn a file arrives, because the file itself is not shown to you again; if no draft is open the reading is still saved and the file can be linked later by calling this again. Describe only what is actually visible in the file.',
    input_schema: {
      type: 'object',
      properties: {
        evidence_id: { type: 'string', description: 'The evidence_id given in <app_context>.' },
        summary: {
          type: 'string',
          description: 'One or two factual sentences on what the file is and shows, including anything unclear or missing.',
        },
        extracted_data: {
          type: 'array',
          description: 'Details read from the file as name/value pairs, for example name, clinic, doctor, dates, approver, approval wording.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['evidence_id', 'summary', 'extracted_data'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_confirmation',
    description:
      'Ask the backend to send the user the confirmation summary. Allowed only when a valid reason is set, the details pass validation and are confirmed, any required evidence is attached, and every checklist step is done or not applicable. If it is refused, the result lists what is still missing. On success the backend sends the summary and asks the user to reply YES, so do not write a summary yourself.',
    input_schema: noInput,
  },
  {
    name: 'cancel_draft',
    description: 'Cancel the open draft when the user no longer wants to go ahead with the request.',
    input_schema: noInput,
  },
];

export function buildTools(strict: boolean): ClaudeTool[] {
  return strict ? TOOL_DEFINITIONS.map((t) => ({ ...t, strict: true })) : TOOL_DEFINITIONS;
}

// --------------------------------------------------------------- executor

export interface ToolContext {
  db: D1Database;
  kb: ActiveKb;
  conversation: Conversation;
  /** Evidence uploaded with the message being processed (the only files Claude can actually see). */
  newEvidenceIds: Set<string>;
  /** Set by request_confirmation; cleared again by any later change in the same turn. */
  confirmationRequested: boolean;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

const ok = (data: Record<string, unknown>): ToolResult => ({ content: JSON.stringify({ ok: true, ...data }), isError: false });
const fail = (error: string, data: Record<string, unknown> = {}): ToolResult => ({
  content: JSON.stringify({ ok: false, error, ...data }),
  isError: true,
});

const NO_DRAFT = 'There is no open request. Call start_or_switch_draft first.';
const STEP_STATUSES: StepStatus[] = ['done', 'not_done', 'not_applicable', 'unknown'];

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function findType(kb: ActiveKb, draft: Draft): KbTypeWithReasons | null {
  return kb.types.find((t) => t.id === draft.transaction_type_id) ?? null;
}

function findReason(type: KbTypeWithReasons | null, code: string | null): KbReason | null {
  return type?.reasons.find((r) => r.code === code) ?? null;
}

/** Any change to what will be submitted cancels a pending confirmation. */
function markChanged(ctx: ToolContext, draft: Draft): void {
  if (draft.status === 'awaiting_confirmation') draft.status = 'collecting';
  ctx.confirmationRequested = false;
}

async function blockers(ctx: ToolContext, draft: Draft): Promise<string[]> {
  const type = findType(ctx.kb, draft);
  return confirmationBlockers({
    draft,
    type,
    reason: findReason(type, draft.reason_code),
    evidence: await listDraftEvidence(ctx.db, draft.id),
  });
}

function describeFields(type: KbTypeWithReasons, reason: KbReason | null) {
  return effectiveFields(type, reason).map((f) => ({ name: f.name, required: f.required, about: f.description || f.title }));
}

export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  const input = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case 'start_or_switch_draft':
      return startOrSwitchDraft(ctx, input);
    case 'set_reason':
      return setReason(ctx, input);
    case 'update_draft_fields':
      return updateDraftFields(ctx, input);
    case 'add_draft_note':
      return addDraftNote(ctx, input);
    case 'set_steps':
      return setSteps(ctx, input);
    case 'update_step':
      return updateStep(ctx, input);
    case 'attach_evidence':
      return attachEvidence(ctx, input);
    case 'request_confirmation':
      return requestConfirmation(ctx);
    case 'cancel_draft':
      return cancelDraft(ctx);
    default:
      return fail(`Unknown tool "${name}".`);
  }
}

async function startOrSwitchDraft(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const key = asString(input.transaction_type_key);
  const type = ctx.kb.types.find((t) => t.key === key);
  if (!type) {
    return fail(`"${key}" is not an active transaction type.`, {
      active_transaction_types: ctx.kb.types.map((t) => ({ key: t.key, name: t.name })),
    });
  }
  const open = await getOpenDraft(ctx.db, ctx.conversation.id);
  let replaced = false;
  if (open) {
    if (open.transaction_type_id === type.id) {
      return ok({
        message: 'A request of this type is already open; continuing with it.',
        status: open.status,
        fields_to_collect: describeFields(type, findReason(type, open.reason_code)),
        allowed_reasons: type.reasons.map((r) => ({ reason_code: r.code, label: r.label })),
      });
    }
    // One open draft per user: the old one is cancelled and its files freed
    // so they can be attached to the new request if they still apply.
    open.status = 'cancelled';
    await saveDraft(ctx.db, open);
    await unlinkDraftEvidence(ctx.db, open.id);
    replaced = true;
  }
  ctx.confirmationRequested = false;
  await createDraft(ctx.db, {
    conversationId: ctx.conversation.id,
    phoneNumber: ctx.conversation.phone_number,
    typeId: type.id,
    typeKey: type.key,
  });
  return ok({
    message:
      (replaced ? 'The previous request was cancelled and a new one opened. ' : 'Request opened. ') +
      'Now save anything the user already told you in the earlier messages (as unconfirmed where it needs checking).',
    fields_to_collect: describeFields(type, null),
    allowed_reasons: type.reasons.map((r) => ({ reason_code: r.code, label: r.label })),
  });
}

async function setReason(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const type = findType(ctx.kb, draft);
  if (!type) return fail('This transaction type is no longer available. Tell the user and cancel the draft.');

  const code = asString(input.reason_code);
  const wording = asString(input.user_wording);
  const reason = findReason(type, code);
  if (!reason) {
    return fail(`"${code}" is not an allowed reason for ${type.name}. Never invent a reason.`, {
      allowed_reasons: type.reasons.map((r) => ({ reason_code: r.code, label: r.label })),
    });
  }
  if (!wording) return fail("user_wording is required: give the reason in the user's own words.");

  const changed = draft.reason_code !== reason.code;
  draft.reason_code = reason.code;
  draft.user_wording = wording.slice(0, 500);
  if (changed) {
    draft.steps = [];
    // Details that belonged only to the previous reason are moved to a note, so nothing the user said is lost.
    const allowed = new Set(effectiveFields(type, reason).map((f) => f.name));
    for (const [fieldName, entry] of Object.entries(draft.fields)) {
      if (allowed.has(fieldName)) continue;
      draft.notes.push({
        text: `Recorded under the previous reason: ${fieldName} = ${JSON.stringify(entry.value)}`,
        at: new Date().toISOString(),
      });
      delete draft.fields[fieldName];
    }
  }
  markChanged(ctx, draft);
  await saveDraft(ctx.db, draft);
  return ok({
    reason: { reason_code: reason.code, label: reason.label },
    evidence: reason.evidence_rule,
    max_days: reason.max_days,
    fields_to_collect: describeFields(type, reason),
    message: changed
      ? "Reason set. The checklist is empty: build it now with set_steps from this reason's process guide."
      : 'Reason unchanged; wording updated.',
    still_needed: await blockers(ctx, draft),
  });
}

async function updateDraftFields(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const type = findType(ctx.kb, draft);
  if (!type) return fail('This transaction type is no longer available. Tell the user and cancel the draft.');
  if (!Array.isArray(input.fields) || input.fields.length === 0) return fail('"fields" must be a non-empty list.');

  const reason = findReason(type, draft.reason_code);
  const specs = new Map(effectiveFields(type, reason).map((f) => [f.name, f]));
  const saved: string[] = [];
  const errors: string[] = [];

  for (const item of input.fields as Record<string, unknown>[]) {
    const fieldName = asString(item?.name);
    const spec = specs.get(fieldName);
    if (!spec) {
      errors.push(
        `${fieldName || '(no name)'}: not a field of this request. Fields: ${[...specs.keys()].join(', ') || 'none'}.` +
          (reason ? '' : ' Reason-specific fields become available after set_reason.') +
          ' Use add_draft_note for other context.',
      );
      continue;
    }
    if (item.value === null || item.value === undefined) {
      delete draft.fields[fieldName];
      saved.push(fieldName);
      continue;
    }
    if (item.status === 'confirmed') {
      const check = checkFieldValue(spec, item.value);
      if (!check.ok) {
        errors.push(check.error);
        continue;
      }
      draft.fields[fieldName] = { value: check.value, status: 'confirmed' };
    } else if (item.status === 'unconfirmed') {
      draft.fields[fieldName] = { value: typeof item.value === 'string' ? item.value.trim() : item.value, status: 'unconfirmed' };
    } else {
      errors.push(`${fieldName}: status must be "confirmed" or "unconfirmed".`);
      continue;
    }
    saved.push(fieldName);
  }

  if (saved.length) {
    markChanged(ctx, draft);
    await saveDraft(ctx.db, draft);
  }
  const result = { saved, errors, still_needed: await blockers(ctx, draft) };
  return saved.length ? ok(result) : fail('Nothing was saved.', result);
}

async function addDraftNote(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const text = asString(input.text);
  if (!text) return fail('The note text is empty.');
  draft.notes.push({ text: text.slice(0, 500), at: new Date().toISOString() });
  draft.notes = draft.notes.slice(-30);
  await saveDraft(ctx.db, draft);
  return ok({ notes: draft.notes.length });
}

async function setSteps(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const type = findType(ctx.kb, draft);
  if (!findReason(type, draft.reason_code)) return fail('Set a valid reason first (set_reason); the checklist comes from its process guide.');

  const texts = Array.isArray(input.steps) ? input.steps.map(asString).filter(Boolean) : [];
  if (texts.length < 1 || texts.length > 12) return fail('Give between 1 and 12 steps, one short line each.');

  const previous = new Map(draft.steps.map((s) => [s.text, s]));
  draft.steps = texts.map((text, i): DraftStep => {
    const kept = previous.get(text);
    return { id: `s${i + 1}`, text: text.slice(0, 200), status: kept?.status ?? 'unknown', note: kept?.note ?? '' };
  });
  markChanged(ctx, draft);
  await saveDraft(ctx.db, draft);
  return ok({ steps: draft.steps, still_needed: await blockers(ctx, draft) });
}

async function updateStep(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const step = draft.steps.find((s) => s.id === asString(input.step_id));
  if (!step) return fail(`No step with id "${asString(input.step_id)}".`, { steps: draft.steps.map((s) => s.id) });
  const status = asString(input.status) as StepStatus;
  if (!STEP_STATUSES.includes(status)) return fail(`status must be one of: ${STEP_STATUSES.join(', ')}.`);
  const note = asString(input.note);
  if (status === 'not_applicable' && !note) return fail('A step marked not_applicable needs a note explaining why.');

  step.status = status;
  step.note = note.slice(0, 300);
  markChanged(ctx, draft);
  await saveDraft(ctx.db, draft);
  return ok({ step, still_needed: await blockers(ctx, draft) });
}

async function attachEvidence(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const evidence = await getEvidence(ctx.db, asString(input.evidence_id));
  if (!evidence || evidence.conversation_id !== ctx.conversation.id) {
    return fail(`No uploaded file with evidence_id "${asString(input.evidence_id)}" for this user.`);
  }
  const summary = asString(input.summary);
  const extracted = (Array.isArray(input.extracted_data) ? input.extracted_data : [])
    .map((d: any) => ({ name: asString(d?.name).slice(0, 80), value: asString(d?.value).slice(0, 500) }))
    .filter((d) => d.name && d.value)
    .slice(0, 30);

  // A reading is only trusted from the turn the file was actually visible.
  // Later calls just link the file and keep the original reading.
  let reading = 'kept the reading recorded when the file arrived';
  if (ctx.newEvidenceIds.has(evidence.id) || !evidence.summary) {
    if (!summary) return fail('summary is required: say what the file shows.');
    await saveEvidenceReading(ctx.db, evidence.id, summary.slice(0, 1000), extracted);
    reading = 'saved';
  }

  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) {
    return ok({
      reading,
      attached: false,
      message: 'No request is open, so the file is not linked yet. Call attach_evidence again once a draft exists.',
    });
  }
  if (evidence.draft_id && evidence.draft_id !== draft.id) {
    return fail('This file belongs to an earlier request and cannot be reused. Ask the user to send it again.');
  }
  await linkEvidence(ctx.db, evidence.id, draft.id);
  markChanged(ctx, draft);
  await saveDraft(ctx.db, draft);
  return ok({ reading, attached: true, still_needed: await blockers(ctx, draft) });
}

async function requestConfirmation(ctx: ToolContext): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail(NO_DRAFT);
  const stillNeeded = await blockers(ctx, draft);
  if (stillNeeded.length) return fail('Confirmation cannot be requested yet.', { still_needed: stillNeeded });

  draft.status = 'awaiting_confirmation';
  draft.error = null;
  await saveDraft(ctx.db, draft);
  ctx.confirmationRequested = true;
  return ok({
    message:
      'The backend is now sending the user the confirmation summary and asking them to reply YES. Do not write a summary yourself; end your turn with at most one short sentence.',
  });
}

async function cancelDraft(ctx: ToolContext): Promise<ToolResult> {
  const draft = await getOpenDraft(ctx.db, ctx.conversation.id);
  if (!draft) return fail('There is no open request to cancel.');
  draft.status = 'cancelled';
  await saveDraft(ctx.db, draft);
  ctx.confirmationRequested = false;
  return ok({ message: 'The request was cancelled.' });
}
