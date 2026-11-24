// Target client used in the prototype. It calls the mock target app's API
// handler directly (same code as `POST /mock-api/transactions`), so every
// submission is validated, recorded and logged exactly like an HTTP call.

import { handleMockTransaction } from '../mock-app/api';
import { toSubmitResult, type SubmitResult, type TargetAppClient } from './client';
import type { TransactionPayload } from './payload';

export class MockTargetAppClient implements TargetAppClient {
  constructor(private readonly db: D1Database) {}

  async submit(payload: TransactionPayload): Promise<SubmitResult> {
    const { status, body } = await handleMockTransaction(this.db, payload, payload.reference);
    return toSubmitResult(status, body);
  }
}
