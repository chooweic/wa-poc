// The ONE generic payload sent to the target application for every
// transaction type and reason. Only the parameters differ, so a reason that a
// business user adds in the KB is submitted without any developer change.

import type { Draft, EvidenceRecord } from '../drafts-repo';
import type { KbReason, KbTransactionType } from '../kb-repo';

export interface TransactionPayload {
  /** The draft id. Also the idempotency key: sending it twice must not create two records. */
  reference: string;
  transaction_type: string;
  reason_code: string;
  reason_label: string;
  /** The user's own words for their reason, kept for audit. */
  user_wording: string;
  /** Sender's WhatsApp number (international format, no "+"). The user's ID in this prototype. */
  phone_number: string;
  /** Collected data as key/value pairs (dates, days, the reason's extra fields). */
  fields: Record<string, unknown>;
  evidence: { id: string; type: string; mime_type: string; link: string }[];
  checklist: { step: string; status: string; note: string }[];
}

export function buildPayload(args: {
  draft: Draft;
  type: KbTransactionType;
  reason: KbReason;
  evidence: EvidenceRecord[];
  /** e.g. "https://wa-poc.example.workers.dev"; evidence links are admin-protected. */
  baseUrl: string;
}): TransactionPayload {
  const { draft, type, reason, evidence, baseUrl } = args;
  const fields: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(draft.fields)) {
    // Only values the user has confirmed are sent. Notes are never sent.
    if (entry.status === 'confirmed') fields[name] = entry.value;
  }
  return {
    reference: draft.id,
    transaction_type: type.key,
    reason_code: reason.code,
    reason_label: reason.label,
    user_wording: draft.user_wording ?? '',
    // Taken from the incoming message, never typed in by the user or chosen by the model.
    phone_number: draft.phone_number,
    fields,
    evidence: evidence.map((e) => ({
      id: e.id,
      type: e.kind,
      mime_type: e.mime_type,
      link: `${baseUrl.replace(/\/$/, '')}/evidence/${e.id}`,
    })),
    checklist: draft.steps.map((s) => ({ step: s.text, status: s.status, note: s.note })),
  };
}
