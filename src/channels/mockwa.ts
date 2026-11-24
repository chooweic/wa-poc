// The simulator channel behind /mock-wa. Replies are written to the
// `mock_wa_messages` table, which the browser page polls. Files are uploaded
// straight to R2 by the page, so there is nothing to download.

import type { MessagingChannel } from './types';

export class MockWaChannel implements MessagingChannel {
  readonly name = 'mock' as const;

  constructor(private readonly db: D1Database) {}

  async sendText(to: string, text: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO mock_wa_messages (phone_number, direction, body) VALUES (?, 'out', ?)`)
      .bind(to, text)
      .run();
  }
}

/** Records what the simulated user sent, so the page can show it as a bubble. */
export async function recordMockUserMessage(
  db: D1Database,
  args: { phone: string; body: string; evidenceId?: string | null; mediaKind?: string | null; mediaName?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mock_wa_messages (phone_number, direction, body, evidence_id, media_kind, media_name) VALUES (?, 'in', ?, ?, ?, ?)`,
    )
    .bind(args.phone, args.body, args.evidenceId ?? null, args.mediaKind ?? null, args.mediaName ?? null)
    .run();
}
