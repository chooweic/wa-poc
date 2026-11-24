// Transaction drafts and their evidence records.
// The draft is the assistant's memory of a request in progress.

import { safeJsonParse } from './util';

export type DraftStatus = 'collecting' | 'awaiting_confirmation' | 'submitted' | 'failed' | 'cancelled';
export type FieldStatus = 'confirmed' | 'unconfirmed';
export type StepStatus = 'done' | 'not_done' | 'not_applicable' | 'unknown';

export interface FieldEntry {
  value: unknown;
  status: FieldStatus;
}

export interface DraftStep {
  id: string;
  text: string;
  status: StepStatus;
  note: string;
}

export interface DraftNote {
  text: string;
  at: string;
}

export interface Draft {
  id: string;
  conversation_id: number;
  phone_number: string;
  transaction_type_id: number;
  transaction_type_key: string;
  reason_code: string | null;
  user_wording: string | null;
  fields: Record<string, FieldEntry>;
  notes: DraftNote[];
  steps: DraftStep[];
  status: DraftStatus;
  target_reference: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRecord {
  id: string;
  conversation_id: number;
  draft_id: string | null;
  message_id: number | null;
  kind: 'image' | 'document';
  mime_type: string;
  size_bytes: number;
  sha256: string;
  r2_key: string;
  filename: string | null;
  summary: string | null;
  extracted_data: { name: string; value: string }[] | null;
  created_at: string;
}

export const OPEN_STATUSES: DraftStatus[] = ['collecting', 'awaiting_confirmation'];

interface DraftRow extends Omit<Draft, 'fields' | 'notes' | 'steps'> {
  fields: string;
  notes: string;
  steps: string;
}

function toDraft(row: DraftRow): Draft {
  return {
    ...row,
    fields: safeJsonParse<Record<string, FieldEntry>>(row.fields, {}),
    notes: safeJsonParse<DraftNote[]>(row.notes, []),
    steps: safeJsonParse<DraftStep[]>(row.steps, []),
  };
}

interface EvidenceRow extends Omit<EvidenceRecord, 'extracted_data'> {
  extracted_data: string | null;
}

function toEvidence(row: EvidenceRow): EvidenceRecord {
  return { ...row, extracted_data: safeJsonParse<{ name: string; value: string }[] | null>(row.extracted_data, null) };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ------------------------------------------------------------------ drafts

export async function getDraft(db: D1Database, id: string): Promise<Draft | null> {
  const row = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>();
  return row ? toDraft(row) : null;
}

/** The one draft this user is working on, if any. */
export async function getOpenDraft(db: D1Database, conversationId: number): Promise<Draft | null> {
  const row = await db
    .prepare(
      `SELECT * FROM drafts WHERE conversation_id = ? AND status IN ('collecting', 'awaiting_confirmation') LIMIT 1`,
    )
    .bind(conversationId)
    .first<DraftRow>();
  return row ? toDraft(row) : null;
}

export async function createDraft(
  db: D1Database,
  args: { conversationId: number; phoneNumber: string; typeId: number; typeKey: string },
): Promise<Draft> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO drafts (id, conversation_id, phone_number, transaction_type_id, transaction_type_key) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, args.conversationId, args.phoneNumber, args.typeId, args.typeKey)
    .run();
  return (await getDraft(db, id)) as Draft;
}

/** Writes the editable parts of a draft back to the database. */
export async function saveDraft(db: D1Database, draft: Draft): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET reason_code = ?, user_wording = ?, fields = ?, notes = ?, steps = ?, status = ?,
         target_reference = ?, error = ?, updated_at = ${NOW} WHERE id = ?`,
    )
    .bind(
      draft.reason_code,
      draft.user_wording,
      JSON.stringify(draft.fields),
      JSON.stringify(draft.notes),
      JSON.stringify(draft.steps),
      draft.status,
      draft.target_reference,
      draft.error,
      draft.id,
    )
    .run();
}

export async function listDrafts(db: D1Database, limit = 100): Promise<Draft[]> {
  const rows = await db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC LIMIT ?').bind(limit).all<DraftRow>();
  return rows.results.map(toDraft);
}

// ---------------------------------------------------------------- evidence

export async function insertEvidence(
  db: D1Database,
  ev: Omit<EvidenceRecord, 'draft_id' | 'summary' | 'extracted_data' | 'created_at'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO evidence (id, conversation_id, message_id, kind, mime_type, size_bytes, sha256, r2_key, filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(ev.id, ev.conversation_id, ev.message_id, ev.kind, ev.mime_type, ev.size_bytes, ev.sha256, ev.r2_key, ev.filename)
    .run();
}

export async function getEvidence(db: D1Database, id: string): Promise<EvidenceRecord | null> {
  const row = await db.prepare('SELECT * FROM evidence WHERE id = ?').bind(id).first<EvidenceRow>();
  return row ? toEvidence(row) : null;
}

export async function listDraftEvidence(db: D1Database, draftId: string): Promise<EvidenceRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM evidence WHERE draft_id = ? ORDER BY created_at ASC, id ASC')
    .bind(draftId)
    .all<EvidenceRow>();
  return rows.results.map(toEvidence);
}

/**
 * Evidence Claude should know about this turn: files linked to the open
 * draft, plus recent uploads not yet linked to any draft (for example a
 * photo sent before the user said what it was for).
 */
export async function listRelevantEvidence(
  db: D1Database,
  conversationId: number,
  openDraftId: string | null,
  since: string | null,
): Promise<EvidenceRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM evidence
       WHERE conversation_id = ?1
         AND (draft_id = ?2 OR (draft_id IS NULL AND (?3 IS NULL OR created_at > ?3)))
       ORDER BY created_at DESC, id DESC LIMIT 8`,
    )
    .bind(conversationId, openDraftId, since)
    .all<EvidenceRow>();
  return rows.results.map(toEvidence).reverse();
}

export async function setEvidenceMessage(db: D1Database, id: string, messageId: number): Promise<void> {
  await db.prepare('UPDATE evidence SET message_id = ? WHERE id = ?').bind(messageId, id).run();
}

export async function saveEvidenceReading(
  db: D1Database,
  id: string,
  summary: string,
  extracted: { name: string; value: string }[],
): Promise<void> {
  await db
    .prepare('UPDATE evidence SET summary = ?, extracted_data = ? WHERE id = ?')
    .bind(summary, JSON.stringify(extracted), id)
    .run();
}

export async function linkEvidence(db: D1Database, id: string, draftId: string): Promise<void> {
  await db.prepare('UPDATE evidence SET draft_id = ? WHERE id = ?').bind(draftId, id).run();
}

/** Detaches files from a draft whose reason or type changed, so they must be checked again. */
export async function unlinkDraftEvidence(db: D1Database, draftId: string): Promise<void> {
  await db.prepare('UPDATE evidence SET draft_id = NULL WHERE draft_id = ?').bind(draftId).run();
}
