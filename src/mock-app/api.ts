// The mock target application: a small stand-in system with ONE endpoint,
// `POST /mock-api/transactions`, used for every transaction type and reason.
// It stands in for the real system, which is out of scope for the prototype.
// Every call (accepted or rejected) is written to `mock_api_log`.
//
// It does NOT keep leave balances: those belong to the HR system, which is
// out of scope. When a transaction would change a leave quota, the mock
// target app logs a SIMULATED call to the HR system (nothing is sent).

export interface MockApiResult {
  status: number;
  body: Record<string, any>;
}

/**
 * What the mock target app does for each reason code it knows about: the
 * status it records, and which leave quota (if any) the HR system would be
 * asked to adjust. A reason code that is NOT in this map (for example one a
 * business user just added in the KB) is still accepted and recorded as
 * `pending_review`, so new reasons work end to end without touching this code.
 */
const REASON_BEHAVIOUR: Record<string, { status: string; hrQuota?: string }> = {
  medical: { status: 'approved', hrQuota: 'medical_leave' },
  supervisor_granted_off: { status: 'approved', hrQuota: 'off_day' },
  no_pay_leave: { status: 'approved', hrQuota: 'no_pay_leave' },
  others: { status: 'pending_review' },
};

/** Where the HR system's quota API would be. Shown in the log only; nothing is sent. */
export const SIMULATED_HR_QUOTA_PATH = 'hr-system /leave-quota/adjustments (simulated)';

/** A downstream call to log after the main one. */
interface SimulatedCall {
  path: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  status: number;
}

interface MockUser {
  phone_number: string;
  name: string;
}

function reject(status: number, code: string, message: string, extra: Record<string, unknown> = {}): MockApiResult {
  return { status, body: { error: { code, message }, ...extra } };
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function process(db: D1Database, payload: any, followUps: SimulatedCall[]): Promise<MockApiResult> {
  // 1. Shape of the generic payload.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return reject(400, 'invalid_request', 'The request body must be a JSON object.');
  }
  const missing = ['reference', 'transaction_type', 'reason_code', 'phone_number'].filter(
    (k) => typeof payload[k] !== 'string' || !payload[k].trim(),
  );
  if (missing.length) return reject(400, 'invalid_request', `Missing required parameter(s): ${missing.join(', ')}.`);
  if (typeof payload.fields !== 'object' || payload.fields === null || Array.isArray(payload.fields)) {
    return reject(400, 'invalid_request', '"fields" must be an object of key/value pairs.');
  }

  // 2. The phone number is the user's ID.
  const user = await db
    .prepare('SELECT * FROM mock_users WHERE phone_number = ?')
    .bind(payload.phone_number)
    .first<MockUser>();
  if (!user) {
    return reject(404, 'user_not_found', `No user matches the phone number ${payload.phone_number}.`);
  }

  // 3. A reference may only be used once.
  const existing = await db
    .prepare('SELECT reference_no FROM mock_leave_records WHERE client_reference = ?')
    .bind(payload.reference)
    .first<{ reference_no: string }>();
  if (existing) {
    return reject(409, 'duplicate_reference', `A record already exists for reference ${payload.reference}.`, {
      reference_no: existing.reference_no,
    });
  }

  // 4. Dates and days.
  const { start_date, end_date, days, ...otherFields } = payload.fields as Record<string, unknown>;
  if (!isDate(start_date) || !isDate(end_date)) {
    return reject(422, 'invalid_dates', 'start_date and end_date are required, as YYYY-MM-DD.');
  }
  if (end_date < start_date) return reject(422, 'invalid_dates', 'end_date is before start_date.');
  if (typeof days !== 'number' || !(days > 0)) {
    return reject(422, 'invalid_days', 'days is required and must be a number greater than 0.');
  }

  // 5. Behaviour depends on the parameters.
  const behaviour = REASON_BEHAVIOUR[payload.reason_code] ?? { status: 'pending_review' };

  // 6. Write the record.
  const details = JSON.stringify({
    fields: otherFields,
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
    checklist: Array.isArray(payload.checklist) ? payload.checklist : [],
  });
  const statements = [
    db
      .prepare(
        `INSERT INTO mock_leave_records
           (reference_no, client_reference, phone_number, transaction_type, reason_code, reason_label, user_wording,
            start_date, end_date, days, status, details)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        payload.reference,
        payload.phone_number,
        payload.transaction_type,
        payload.reason_code,
        typeof payload.reason_label === 'string' ? payload.reason_label : null,
        typeof payload.user_wording === 'string' ? payload.user_wording : null,
        start_date,
        end_date,
        days,
        behaviour.status,
        details,
      ),
    // The mock app's own reference number, e.g. TX-000042.
    db
      .prepare(`UPDATE mock_leave_records SET reference_no = 'TX-' || printf('%06d', id) WHERE client_reference = ?`)
      .bind(payload.reference),
  ];
  await db.batch(statements);

  const record = await db
    .prepare('SELECT reference_no, status FROM mock_leave_records WHERE client_reference = ?')
    .bind(payload.reference)
    .first<{ reference_no: string; status: string }>();

  // 7. Leave quotas live in the HR system (out of scope). An approved record
  //    that affects a quota would be passed on there; the call is simulated.
  let hrQuota: Record<string, unknown> | null = null;
  if (behaviour.hrQuota && behaviour.status === 'approved') {
    followUps.push({
      path: SIMULATED_HR_QUOTA_PATH,
      request: {
        phone_number: user.phone_number,
        quota: behaviour.hrQuota,
        days,
        start_date,
        end_date,
        source_reference: record?.reference_no,
      },
      response: { simulated: true, note: 'Not sent anywhere: the HR system is out of scope for this prototype.' },
      status: 200,
    });
    hrQuota = { simulated: true, quota: behaviour.hrQuota, days };
  }

  return {
    status: 201,
    body: {
      reference_no: record?.reference_no,
      status: record?.status,
      transaction_type: payload.transaction_type,
      reason_code: payload.reason_code,
      days,
      hr_quota_adjustment: hrQuota,
    },
  };
}

/** Handles one call to `POST /mock-api/transactions` and logs it in full. */
export async function handleMockTransaction(
  db: D1Database,
  payload: unknown,
  idempotencyKey: string | null,
): Promise<MockApiResult> {
  let result: MockApiResult;
  const followUps: SimulatedCall[] = [];
  try {
    result = await process(db, payload, followUps);
  } catch (e) {
    console.error('mock api error:', (e as Error).message);
    result = reject(500, 'internal_error', 'The system had an internal error.');
    followUps.length = 0;
  }
  const log =
    "INSERT INTO mock_api_log (method, path, idempotency_key, request_json, response_json, status) VALUES ('POST', ?, ?, ?, ?, ?)";
  // The incoming call first, then anything it would have triggered downstream.
  await db.batch([
    db.prepare(log).bind('/mock-api/transactions', idempotencyKey, JSON.stringify(payload ?? null), JSON.stringify(result.body), result.status),
    ...followUps.map((f) => db.prepare(log).bind(f.path, idempotencyKey, JSON.stringify(f.request), JSON.stringify(f.response), f.status)),
  ]);
  return result;
}

/** Everything the /mock-app dashboard shows. */
export async function getMockState(db: D1Database): Promise<Record<string, unknown>> {
  const [users, records, log] = await Promise.all([
    db.prepare('SELECT * FROM mock_users ORDER BY name').all(),
    db.prepare('SELECT * FROM mock_leave_records ORDER BY id DESC LIMIT 50').all(),
    db.prepare('SELECT * FROM mock_api_log ORDER BY id DESC LIMIT 30').all(),
  ]);
  return { users: users.results, records: records.results, log: log.results };
}
