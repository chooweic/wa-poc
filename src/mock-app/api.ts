// The mock target application: a small stand-in system with ONE endpoint,
// `POST /mock-api/transactions`, used for every transaction type and reason.
// It stands in for the real system, which is out of scope for the prototype.
// Every call (accepted or rejected) is written to `mock_api_log`.

export interface MockApiResult {
  status: number;
  body: Record<string, any>;
}

/**
 * What the mock target app does for each reason code it knows about.
 * A reason code that is NOT in this map (for example one a business user
 * just added in the KB) is still accepted and recorded as `pending_review`,
 * so new reasons work end to end without touching this code.
 */
const REASON_BEHAVIOUR: Record<
  string,
  { deductFrom?: 'sick_leave_balance' | 'off_day_balance'; addTo?: 'unpaid_days_taken'; status: string }
> = {
  medical: { deductFrom: 'sick_leave_balance', status: 'approved' },
  supervisor_granted_off: { deductFrom: 'off_day_balance', status: 'approved' },
  no_pay_leave: { addTo: 'unpaid_days_taken', status: 'approved' },
  others: { status: 'pending_review' },
};

const BALANCE_NAMES: Record<string, string> = {
  sick_leave_balance: 'medical leave',
  off_day_balance: 'off-day',
};

interface MockUser {
  phone_number: string;
  name: string;
  sick_leave_balance: number;
  off_day_balance: number;
  unpaid_days_taken: number;
}

function reject(status: number, code: string, message: string, extra: Record<string, unknown> = {}): MockApiResult {
  return { status, body: { error: { code, message }, ...extra } };
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function process(db: D1Database, payload: any): Promise<MockApiResult> {
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
  if (behaviour.deductFrom && user[behaviour.deductFrom] < days) {
    return reject(
      422,
      'insufficient_balance',
      `Not enough ${BALANCE_NAMES[behaviour.deductFrom]} balance: ${user[behaviour.deductFrom]} day(s) left, ${days} requested.`,
    );
  }

  // 6. Write the record and update balances together.
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
  if (behaviour.deductFrom) {
    statements.push(
      db
        .prepare(`UPDATE mock_users SET ${behaviour.deductFrom} = ${behaviour.deductFrom} - ? WHERE phone_number = ?`)
        .bind(days, user.phone_number),
    );
  }
  if (behaviour.addTo) {
    statements.push(
      db
        .prepare(`UPDATE mock_users SET ${behaviour.addTo} = ${behaviour.addTo} + ? WHERE phone_number = ?`)
        .bind(days, user.phone_number),
    );
  }
  await db.batch(statements);

  const record = await db
    .prepare('SELECT reference_no, status FROM mock_leave_records WHERE client_reference = ?')
    .bind(payload.reference)
    .first<{ reference_no: string; status: string }>();
  const after = await db
    .prepare('SELECT sick_leave_balance, off_day_balance, unpaid_days_taken FROM mock_users WHERE phone_number = ?')
    .bind(user.phone_number)
    .first();

  return {
    status: 201,
    body: {
      reference_no: record?.reference_no,
      status: record?.status,
      transaction_type: payload.transaction_type,
      reason_code: payload.reason_code,
      days,
      balances: after,
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
  try {
    result = await process(db, payload);
  } catch (e) {
    console.error('mock api error:', (e as Error).message);
    result = reject(500, 'internal_error', 'The system had an internal error.');
  }
  await db
    .prepare(
      `INSERT INTO mock_api_log (method, path, idempotency_key, request_json, response_json, status)
       VALUES ('POST', '/mock-api/transactions', ?, ?, ?, ?)`,
    )
    .bind(idempotencyKey, JSON.stringify(payload ?? null), JSON.stringify(result.body), result.status)
    .run();
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
