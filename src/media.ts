// Evidence files: type and size checks, storing in R2, and loading for Claude.
// File contents and base64 are never logged.

import { Buffer } from 'node:buffer';
import { getEvidence, insertEvidence, type EvidenceRecord } from './drafts-repo';
import { sha256Hex } from './util';

const ALLOWED_TYPES: Record<string, { kind: 'image' | 'document'; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'application/pdf': { kind: 'document', ext: 'pdf' },
};

/** "image/jpeg; codecs=..." -> "image/jpeg" */
export function baseMimeType(mimeType: string): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Returns a friendly message explaining why a file cannot be accepted,
 * or null when it is fine. Used by both channels.
 */
export function mediaRejection(mimeType: string, sizeBytes: number, maxBytes: number): string | null {
  if (!ALLOWED_TYPES[baseMimeType(mimeType)]) {
    return "Sorry, I can't read that kind of file. Please send a photo (JPEG or PNG) or a PDF.";
  }
  if (sizeBytes > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    return `Sorry, that file is too large (the limit is ${mb} MB). Please send a smaller photo or PDF.`;
  }
  if (sizeBytes === 0) return 'Sorry, that file seems to be empty. Please try sending it again.';
  return null;
}

/** The reply for message kinds the assistant does not handle (voice notes, stickers, locations...). */
export function unsupportedMessageReply(kind?: string): string {
  const what = kind ? `${kind} messages` : 'that kind of message';
  return `Sorry, I can't handle ${what} yet. Please send text, a photo (JPEG or PNG) or a PDF.`;
}

/** Saves a file to R2 and records its metadata against the conversation. */
export async function storeEvidence(
  db: D1Database,
  bucket: R2Bucket,
  args: {
    conversationId: number;
    messageId: number | null;
    bytes: ArrayBuffer;
    mimeType: string;
    filename?: string | null;
  },
): Promise<EvidenceRecord> {
  const mime = baseMimeType(args.mimeType);
  const type = ALLOWED_TYPES[mime];
  if (!type) throw new Error(`unsupported media type: ${mime}`);

  const id = crypto.randomUUID();
  const r2Key = `evidence/${args.conversationId}/${id}.${type.ext}`;
  await bucket.put(r2Key, args.bytes, { httpMetadata: { contentType: mime } });

  await insertEvidence(db, {
    id,
    conversation_id: args.conversationId,
    message_id: args.messageId,
    kind: type.kind,
    mime_type: mime,
    size_bytes: args.bytes.byteLength,
    sha256: await sha256Hex(args.bytes),
    r2_key: r2Key,
    filename: args.filename?.slice(0, 200) ?? null,
  });
  return (await getEvidence(db, id)) as EvidenceRecord;
}

/** Reads a stored file as base64, to show it to Claude on the turn it arrives. */
export async function loadEvidenceBase64(bucket: R2Bucket, evidence: EvidenceRecord): Promise<string | null> {
  const object = await bucket.get(evidence.r2_key);
  if (!object) return null;
  return Buffer.from(await object.arrayBuffer()).toString('base64');
}
