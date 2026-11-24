// Knowledge base storage: articles, transaction types and reasons.
// Business users edit the free-text columns; the JSON columns are "technical".

import { slugify } from './util';

export type EvidenceRule = 'required' | 'optional' | 'none';

export interface KbArticle {
  id: number;
  title: string;
  content: string;
  tags: string;
  is_active: number;
  sort_order: number;
}

export interface KbTransactionType {
  id: number;
  key: string;
  name: string;
  description: string;
  process_guide: string;
  fields_schema: string;
  is_active: number;
  sort_order: number;
}

export interface KbReason {
  id: number;
  type_id: number;
  code: string;
  label: string;
  process_guide: string;
  evidence_rule: EvidenceRule;
  max_days: number | null;
  extra_fields_schema: string | null;
  is_active: number;
  sort_order: number;
}

export interface KbTypeWithReasons extends KbTransactionType {
  reasons: KbReason[];
}

/** Everything Claude is shown: only active records, in a fixed order. */
export interface ActiveKb {
  articles: KbArticle[];
  types: KbTypeWithReasons[];
}

const ORDER = 'ORDER BY sort_order ASC, id ASC';

export async function listArticles(db: D1Database, activeOnly = false): Promise<KbArticle[]> {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return (await db.prepare(`SELECT * FROM kb_articles ${where} ${ORDER}`).all<KbArticle>()).results;
}

export async function listTypes(db: D1Database, activeOnly = false): Promise<KbTransactionType[]> {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return (await db.prepare(`SELECT * FROM kb_transaction_types ${where} ${ORDER}`).all<KbTransactionType>()).results;
}

export async function listReasons(db: D1Database, activeOnly = false): Promise<KbReason[]> {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return (await db.prepare(`SELECT * FROM kb_reasons ${where} ${ORDER}`).all<KbReason>()).results;
}

export async function listTypesWithReasons(db: D1Database, activeOnly = false): Promise<KbTypeWithReasons[]> {
  const [types, reasons] = await Promise.all([listTypes(db, activeOnly), listReasons(db, activeOnly)]);
  return types.map((t) => ({ ...t, reasons: reasons.filter((r) => r.type_id === t.id) }));
}

/** Loaded fresh on every inbound message, so KB edits apply without a redeploy. */
export async function loadActiveKb(db: D1Database): Promise<ActiveKb> {
  const [articles, types] = await Promise.all([listArticles(db, true), listTypesWithReasons(db, true)]);
  return { articles, types };
}

export async function getArticle(db: D1Database, id: number): Promise<KbArticle | null> {
  return db.prepare('SELECT * FROM kb_articles WHERE id = ?').bind(id).first<KbArticle>();
}

export async function getType(db: D1Database, id: number): Promise<KbTransactionType | null> {
  return db.prepare('SELECT * FROM kb_transaction_types WHERE id = ?').bind(id).first<KbTransactionType>();
}

export async function getReason(db: D1Database, id: number): Promise<KbReason | null> {
  return db.prepare('SELECT * FROM kb_reasons WHERE id = ?').bind(id).first<KbReason>();
}

// ------------------------------------------------------------------ writes

async function nextSortOrder(db: D1Database, table: string, where = '', ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM ${table} ${where}`)
    .bind(...binds)
    .first<{ next: number }>();
  return row?.next ?? 10;
}

async function uniqueSlug(base: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
  let candidate = base;
  for (let n = 2; await exists(candidate); n++) candidate = `${base}_${n}`;
  return candidate;
}

const touch = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export async function saveArticle(
  db: D1Database,
  id: number | null,
  data: { title: string; content: string; tags: string; is_active: boolean },
): Promise<void> {
  if (id === null) {
    await db
      .prepare('INSERT INTO kb_articles (title, content, tags, is_active, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(data.title, data.content, data.tags, data.is_active ? 1 : 0, await nextSortOrder(db, 'kb_articles'))
      .run();
  } else {
    await db
      .prepare(`UPDATE kb_articles SET title = ?, content = ?, tags = ?, is_active = ?, ${touch} WHERE id = ?`)
      .bind(data.title, data.content, data.tags, data.is_active ? 1 : 0, id)
      .run();
  }
}

export async function saveType(
  db: D1Database,
  id: number | null,
  data: { name: string; description: string; process_guide: string; is_active: boolean },
): Promise<void> {
  if (id === null) {
    // The key is generated once from the name and never changes afterwards,
    // so existing drafts and records keep pointing at the right type.
    const key = await uniqueSlug(slugify(data.name), async (k) =>
      Boolean(await db.prepare('SELECT 1 FROM kb_transaction_types WHERE key = ?').bind(k).first()),
    );
    await db
      .prepare(
        'INSERT INTO kb_transaction_types (key, name, description, process_guide, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        key,
        data.name,
        data.description,
        data.process_guide,
        data.is_active ? 1 : 0,
        await nextSortOrder(db, 'kb_transaction_types'),
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE kb_transaction_types SET name = ?, description = ?, process_guide = ?, is_active = ?, ${touch} WHERE id = ?`,
      )
      .bind(data.name, data.description, data.process_guide, data.is_active ? 1 : 0, id)
      .run();
  }
}

export async function saveReason(
  db: D1Database,
  id: number | null,
  data: {
    type_id: number;
    label: string;
    process_guide: string;
    evidence_rule: EvidenceRule;
    max_days: number | null;
    is_active: boolean;
  },
): Promise<void> {
  if (id === null) {
    const code = await uniqueSlug(slugify(data.label), async (c) =>
      Boolean(await db.prepare('SELECT 1 FROM kb_reasons WHERE type_id = ? AND code = ?').bind(data.type_id, c).first()),
    );
    await db
      .prepare(
        'INSERT INTO kb_reasons (type_id, code, label, process_guide, evidence_rule, max_days, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        data.type_id,
        code,
        data.label,
        data.process_guide,
        data.evidence_rule,
        data.max_days,
        data.is_active ? 1 : 0,
        await nextSortOrder(db, 'kb_reasons', 'WHERE type_id = ?', data.type_id),
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE kb_reasons SET label = ?, process_guide = ?, evidence_rule = ?, max_days = ?, is_active = ?, ${touch} WHERE id = ?`,
      )
      .bind(data.label, data.process_guide, data.evidence_rule, data.max_days, data.is_active ? 1 : 0, id)
      .run();
  }
}

export type KbTable = 'kb_articles' | 'kb_transaction_types' | 'kb_reasons';

export async function setActive(db: D1Database, table: KbTable, id: number, active: boolean): Promise<void> {
  await db.prepare(`UPDATE ${table} SET is_active = ?, ${touch} WHERE id = ?`).bind(active ? 1 : 0, id).run();
}

export async function deleteRow(db: D1Database, table: KbTable, id: number): Promise<void> {
  if (table === 'kb_transaction_types') {
    await db.prepare('DELETE FROM kb_reasons WHERE type_id = ?').bind(id).run();
  }
  await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
}

/** Moves a row one place up or down among its siblings by swapping sort_order values. */
export async function moveRow(db: D1Database, table: KbTable, id: number, direction: 'up' | 'down'): Promise<void> {
  const scope = table === 'kb_reasons' ? 'WHERE type_id = (SELECT type_id FROM kb_reasons WHERE id = ?1)' : '';
  const stmt = db.prepare(`SELECT id, sort_order FROM ${table} ${scope} ${ORDER}`);
  const rows = (await (scope ? stmt.bind(id) : stmt).all<{ id: number; sort_order: number }>()).results;
  const index = rows.findIndex((r) => r.id === id);
  const other = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || other < 0 || other >= rows.length) return;
  // Renumber everything so ties in sort_order can never block a move.
  const ordered = [...rows];
  [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
  await db.batch(
    ordered.map((r, i) => db.prepare(`UPDATE ${table} SET sort_order = ?, ${touch} WHERE id = ?`).bind((i + 1) * 10, r.id)),
  );
}

// --------------------------------------------------------- technical tab

export async function saveTypeSchema(db: D1Database, id: number, fieldsSchema: string): Promise<void> {
  await db.prepare(`UPDATE kb_transaction_types SET fields_schema = ?, ${touch} WHERE id = ?`).bind(fieldsSchema, id).run();
}

export async function saveReasonSchema(db: D1Database, id: number, extraFieldsSchema: string | null): Promise<void> {
  await db.prepare(`UPDATE kb_reasons SET extra_fields_schema = ?, ${touch} WHERE id = ?`).bind(extraFieldsSchema, id).run();
}
