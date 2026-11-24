// Adapter for the target application. The orchestrator only knows this
// interface; which implementation is used is chosen by configuration.

import type { TransactionPayload } from './payload';

export interface SubmitResult {
  ok: boolean;
  /** HTTP status from the target app (0 when it could not be reached). */
  status: number;
  /** The target app's reference number, on success. */
  reference?: string;
  /** e.g. "approved" or "pending_review", when the target app reports it. */
  recordStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  /** True for failures worth trying again with the same reference (network errors, 5xx). */
  retryable: boolean;
}

export interface TargetAppClient {
  submit(payload: TransactionPayload): Promise<SubmitResult>;
}

/** Turns the target app's HTTP status + JSON body into a SubmitResult. Shared by both clients. */
export function toSubmitResult(status: number, body: Record<string, any> | null): SubmitResult {
  if (status >= 200 && status < 300) {
    return { ok: true, status, reference: body?.reference_no, recordStatus: body?.status, retryable: false };
  }
  return {
    ok: false,
    status,
    // Present on a duplicate: the reference of the record that already exists.
    reference: body?.reference_no,
    errorCode: body?.error?.code ?? 'unknown_error',
    errorMessage: body?.error?.message ?? `The system returned status ${status}.`,
    retryable: status >= 500 || status === 0,
  };
}

/**
 * Client for a real HTTP API. Not used in the prototype; set
 * TARGET_APP_MODE=http, TARGET_APP_URL and TARGET_APP_API_KEY to switch to it.
 */
export class HttpTargetAppClient implements TargetAppClient {
  constructor(
    private readonly url: string,
    private readonly apiKey?: string,
  ) {}

  async submit(payload: TransactionPayload): Promise<SubmitResult> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': payload.reference,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as Record<string, any> | null;
      return toSubmitResult(response.status, body);
    } catch {
      return toSubmitResult(0, { error: { code: 'unreachable', message: 'The system could not be reached.' } });
    }
  }
}
