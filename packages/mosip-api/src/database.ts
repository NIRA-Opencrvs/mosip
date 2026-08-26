import DatabaseSync, { Database } from "better-sqlite3";

/*
 * Lightweight SQLite database for storing transaction id with a JWT token
 *
 * OpenCRVS Core issues a record-specific token used to confirm the registration after it is received from MOSIP.
 * Optimally, MOSIP could receive this token as metadata and return it back in WebSub to avoid storage, but this is not currently supported by MOSIP.
 */

const DATABASE_SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    registration_number TEXT UNIQUE NOT NULL,
    action_type TEXT,
    requested_id TEXT, 
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT
`;

const FAILED_RECORDS_SCHEMA = `
  CREATE TABLE failed_records (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    tracking_id TEXT NOT NULL,
    token TEXT NOT NULL,
    request_fields TEXT NOT NULL,
    audit TEXT NOT NULL,
    meta_info TEXT,
    notification TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT
`;

// Verifications parked because IDA was unreachable. Separate from
// failed_records so the MOSIP packet queue is untouched.
const PENDING_VERIFICATIONS_SCHEMA = `
  CREATE TABLE pending_verifications (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    action_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action_type TEXT NOT NULL,
    token TEXT NOT NULL,
    event_document TEXT NOT NULL,
    verified TEXT,
    pending_requests TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;
  CREATE INDEX idx_pending_verifications_due ON pending_verifications(next_retry_at);
`;

let database: Database;

export const initSqlite = (path: string) => {
  database = new DatabaseSync(path);

  const tableExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'",
    )
    .get();

  if (!tableExists) {
    database.exec(DATABASE_SCHEMA);
  }

  const failedRecordsTableExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='failed_records'",
    )
    .get();

  if (!failedRecordsTableExists) {
    database.exec(FAILED_RECORDS_SCHEMA);
  }

  const pendingVerificationsTableExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_verifications'",
    )
    .get();

  if (!pendingVerificationsTableExists) {
    database.exec(PENDING_VERIFICATIONS_SCHEMA);
  }

  return { wasCreated: !tableExists, wasConnected: tableExists, database };
};

export const insertTransaction = (
  id: string,
  token: string,
  registrationNumber: string,
  actionType?: string,
  requestedId?: string
) =>
  database
    .prepare(
      `INSERT INTO transactions (id, token, registration_number, action_type, requested_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         token = excluded.token,
         registration_number = excluded.registration_number,
         action_type = excluded.action_type,
         requested_id = excluded.requested_id`,
    )
    .run(id, token, registrationNumber, actionType ?? null, requestedId ?? null);

export const insertTransactions = (
  records: Array<{
    id: string;
    token: string;
    registrationNumber: string;
    actionType?: string;
    requestedId?: string;
  }>,
) => {
  const insert = database.prepare(
    `INSERT INTO transactions (id, token, registration_number, action_type, requested_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       token = excluded.token,
       registration_number = excluded.registration_number,
       action_type = excluded.action_type,
       requested_id = excluded.requested_id`,
  );

  const runInTransaction = database.transaction((items) => {
    for (const item of items) {
      insert.run(
        item.id,
        item.token,
        item.registrationNumber,
        item.actionType ?? null,
        item.requestedId ?? null,
      );
    }
  });

  runInTransaction(records);
};

/**
 * Looks up the MOSIP identifier previously stored for a registration number.
 */
export const findPreRegIdByRegistrationNumber = (registrationNumber: string) =>
  (
    database
      .prepare("SELECT id FROM transactions WHERE registration_number = ?")
      .get(registrationNumber) as { id: string } | undefined
  )?.id;

/**
 * Looks up the MOSIP pre-registration id previously stored for a declaration.
 */
export const findPreRegIdByTrackingId = (trackingId: string) =>
  (
    database
      .prepare("SELECT id FROM transactions WHERE id >= ? AND id < ? LIMIT 1")
      .get(`${trackingId}-`, `${trackingId}.`) as { id: string } | undefined
  )?.id;

export const hasTransactionForRegistrationNumber = (
  registrationNumber: string,
): boolean =>
  database
    .prepare("SELECT 1 FROM transactions WHERE registration_number = ? LIMIT 1")
    .get(registrationNumber) !== undefined;

/**
 * Checks whether a transaction already exists for a declaration.
 */
export const hasTransactionForTrackingId = (
  trackingId: string,
): boolean =>
  database
    .prepare("SELECT 1 FROM transactions WHERE id LIKE ? LIMIT 1")
    .get(`${trackingId}-%`) !== undefined;


export const hasPendingFailedRecordForTracking = (
  trackingId: string,
): boolean =>
  database
    .prepare("SELECT 1 FROM failed_records WHERE tracking_id = ? LIMIT 1")
    .get(trackingId) !== undefined;

export const getTransaction = (id: string) => {
  const transaction = database
    .prepare(
      "SELECT token, registration_number, action_type, requested_id FROM transactions WHERE id = ?",
    )
    .get(id) as { token: string; registration_number: string; action_type?: string; requested_id?: string} | undefined;

  if (!transaction) {
    throw new Error(`Transaction with id '${id}' not found.`);
  }

  return {
    token: transaction.token,
    registrationNumber: transaction.registration_number,
    actionType: transaction.action_type,
    requestedId: transaction.requested_id
  };
};

export const discardTransaction = (id: string) => {
  database.prepare("DELETE FROM transactions WHERE id = ?").run(id);
};

export const getTransactionAndDiscard = (id: string) => {
  const remove = database
    .prepare(
      "DELETE FROM transactions WHERE id = ? RETURNING token, registration_number",
    )
    .get(id) as { token: string; registration_number: string } | undefined;

  if (!remove) {
    throw new Error(`Transaction with id '${id}' not found.`);
  }

  return {
    token: remove.token,
    registrationNumber: remove.registration_number,
  };
};

/**
 * Retrieves all transactions from the database.
 *
 * @warning
 * This function is intended for **debugging purposes only** as it exposes sensitive data.
 */
export const getAllTransactions = () => {
  return database
    .prepare(
      "SELECT id, registration_number, token, created_at FROM transactions",
    )
    .all() as Array<{
    id: string;
    registration_number: string;
    token: string;
    created_at: string;
  }>;
};

export const updateTransactionToken = (id: string, newToken: string) => {
  const result = database
    .prepare("UPDATE transactions SET token = ? WHERE id = ?")
    .run(newToken, id);

  if (result.changes === 0) {
    throw new Error(`Transaction with id '${id}' not found.`);
  }
};

export const updateAllTransactionsToken = (newToken: string) => {
  const result = database
    .prepare("UPDATE transactions SET token = ?")
    .run(newToken);

  return {
    updatedCount: result.changes,
    newToken,
  };
};

export const exit = () => database.close();

// Failed Records Management

export interface FailedRecord {
  id: string;
  eventType: "birth" | "death";
  trackingId: string;
  token: string;
  requestFields: Record<string, unknown>;
  audit: Record<string, unknown>;
  metaInfo?: Record<string, unknown>;
  notification?: Record<string, unknown>;
  retryCount: number;
  lastError?: string;
  nextRetryAt: string;
}

export const insertFailedRecord = (
  id: string,
  eventType: "birth" | "death",
  trackingId: string,
  token: string,
  requestFields: Record<string, unknown>,
  audit: Record<string, unknown>,
  metaInfo: Record<string, unknown> | undefined,
  notification: Record<string, unknown> | undefined,
  lastError: string,
) => {
  database
    .prepare(
      `INSERT INTO failed_records 
       (id, event_type, tracking_id, token, request_fields, audit, meta_info, notification, last_error, retry_count, next_retry_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      id,
      eventType,
      trackingId,
      token,
      JSON.stringify(requestFields),
      JSON.stringify(audit),
      metaInfo ? JSON.stringify(metaInfo) : null,
      notification ? JSON.stringify(notification) : null,
      lastError,
      0,
    );
};

export const getFailedRecordsForRetry = (limit = 10) => {
  const records = database
    .prepare(
      `SELECT id, event_type, tracking_id, token, request_fields, audit, meta_info, notification, retry_count, last_error, next_retry_at, created_at
       FROM failed_records
       WHERE next_retry_at <= datetime('now')
       ORDER BY retry_count ASC, created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    event_type: "birth" | "death";
    tracking_id: string;
    token: string;
    request_fields: string;
    audit: string;
    meta_info: string | null;
    notification: string | null;
    retry_count: number;
    last_error: string;
    next_retry_at: string;
    created_at: string;
  }>;

  return records.map((record) => ({
    id: record.id,
    eventType: record.event_type,
    trackingId: record.tracking_id,
    token: record.token,
    requestFields: JSON.parse(record.request_fields) as Record<string, unknown>,
    audit: JSON.parse(record.audit) as Record<string, unknown>,
    metaInfo: record.meta_info ? JSON.parse(record.meta_info) as Array<{label: string, value: string}> : undefined,
    notification: record.notification ? JSON.parse(record.notification) : undefined,
    retryCount: record.retry_count,
    lastError: record.last_error,
    nextRetryAt: record.next_retry_at,
    createdAt: record.created_at,
  }));
};

export const getAllFailedRecords = (limit = 10) => {
  const records = database
    .prepare(
      `SELECT id, event_type, tracking_id, token, request_fields, audit, meta_info, notification, retry_count, last_error, next_retry_at, created_at
       FROM failed_records
       ORDER BY retry_count ASC, created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    event_type: "birth" | "death";
    tracking_id: string;
    token: string;
    request_fields: string;
    audit: string;
    meta_info: string | null;
    notification: string | null;
    retry_count: number;
    last_error: string;
    next_retry_at: string;
    created_at: string;
  }>;

  return records.map((record) => ({
    id: record.id,
    eventType: record.event_type,
    trackingId: record.tracking_id,
    token: record.token,
    requestFields: JSON.parse(record.request_fields) as Record<string, unknown>,
    audit: JSON.parse(record.audit) as Record<string, unknown>,
    metaInfo: record.meta_info ? JSON.parse(record.meta_info) : undefined,
    notification: record.notification ? JSON.parse(record.notification) : undefined,
    retryCount: record.retry_count,
    lastError: record.last_error,
    nextRetryAt: record.next_retry_at,
    createdAt: record.created_at,
  }));
};

export const getFailedRecordById = (id: string) => {
  const record = database
    .prepare(
      `SELECT id, event_type, tracking_id, token, request_fields, audit, meta_info, notification, retry_count, last_error, next_retry_at, created_at
       FROM failed_records
       WHERE id = ?`,
    )
    .get(id) as {
      id: string;
      event_type: "birth" | "death";
      tracking_id: string;
      token: string;
      request_fields: string;
      audit: string;
      meta_info: string | null;
      notification: string | null;
      retry_count: number;
      last_error: string;
      next_retry_at: string;
      created_at: string;
    } | undefined;

  if (!record) return undefined;

  return {
    id: record.id,
    eventType: record.event_type,
    trackingId: record.tracking_id,
    token: record.token,
    requestFields: JSON.parse(record.request_fields) as Record<string, unknown>,
    audit: JSON.parse(record.audit) as Record<string, unknown>,
    metaInfo: record.meta_info ? JSON.parse(record.meta_info) as Array<{label: string, value: string}>  : undefined,
    notification: record.notification ? JSON.parse(record.notification) : undefined,
    retryCount: record.retry_count,
    lastError: record.last_error,
    nextRetryAt: record.next_retry_at,
    createdAt: record.created_at,
  };
};

export const incrementFailedRecordRetry = (id: string, error: string) => {
  database
    .prepare(
      `UPDATE failed_records 
       SET retry_count = retry_count + 1, last_error = ?, next_retry_at = datetime('now', '+' || CAST(POWER(2, retry_count) * 5 AS TEXT) || ' minutes'), updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error, id);
};

export const removeFailedRecord = (id: string) => {
  database.prepare("DELETE FROM failed_records WHERE id = ?").run(id);
};

export const removeFailedRecordAndReturnData = (id: string) => {
  const removed = database
    .prepare(
      `DELETE FROM failed_records WHERE id = ? RETURNING event_type, tracking_id, token, request_fields, audit, meta_info, notification, retry_count`,
    )
    .get(id) as {
    event_type: "birth" | "death";
    tracking_id: string;
    token: string;
    request_fields: string;
    audit: string;
    meta_info: string | null;
    notification: string | null;
    retry_count: number;
  } | undefined;

  if (!removed) {
    return null;
  }

  return {
    eventType: removed.event_type,
    trackingId: removed.tracking_id,
    token: removed.token,
    requestFields: JSON.parse(removed.request_fields) as Record<string, unknown>,
    audit: JSON.parse(removed.audit) as Record<string, unknown>,
    metaInfo: removed.meta_info ? JSON.parse(removed.meta_info) : undefined,
    notification: removed.notification
      ? JSON.parse(removed.notification)
      : undefined,
    retryCount: removed.retry_count,
  };
};


/** One IDA call that could not be completed, stored verbatim so it can be replayed. */
export type PendingVerificationRequest = {
  nid: string;
  dob?: string;
  name: Record<string, unknown>;
  gender?: string;
  transactionId?: string;
};

/** A verdict IDA returned, by transaction id. */
export type VerifiedResults = Record<string, unknown>;

export interface PendingVerification {
  id: string;
  eventId: string;
  actionId: string;
  eventType: string;
  actionType: string;
  token: string;
  eventDocument: Record<string, unknown>;
  /** Verdicts already obtained, by transaction id. */
  verified?: VerifiedResults;
  /** The calls still to be replayed. */
  pendingRequests?: PendingVerificationRequest[];
  retryCount: number;
  lastError?: string;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
}

type PendingVerificationRow = {
  id: string;
  event_id: string;
  action_id: string;
  event_type: string;
  action_type: string;
  token: string;
  event_document: string;
  verified: string | null;
  pending_requests: string | null;
  retry_count: number;
  last_error: string | null;
  next_retry_at: string;
  created_at: string;
  updated_at: string;
};

const PENDING_VERIFICATION_COLUMNS = `id, event_id, action_id, event_type, action_type, token, event_document, verified, pending_requests, retry_count, last_error, next_retry_at, created_at, updated_at`;

const parseJsonColumn = <T>(value: string | null): T | undefined =>
  value ? (JSON.parse(value) as T) : undefined;

const toPendingVerification = (
  row: PendingVerificationRow,
): PendingVerification => ({
  id: row.id,
  eventId: row.event_id,
  actionId: row.action_id,
  eventType: row.event_type,
  actionType: row.action_type,
  token: row.token,
  eventDocument: JSON.parse(row.event_document) as Record<string, unknown>,
  verified: parseJsonColumn<VerifiedResults>(row.verified),
  pendingRequests: parseJsonColumn<PendingVerificationRequest[]>(
    row.pending_requests,
  ),
  retryCount: row.retry_count,
  lastError: row.last_error ?? undefined,
  nextRetryAt: row.next_retry_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** One job per action; a unique index also allows only one per record. */
export const pendingVerificationId = (eventId: string, actionId: string) =>
  `${eventId}:${actionId}`;

/** Idempotent. Returns true when a new job was created. */
export const insertPendingVerification = ({
  eventId,
  actionId,
  eventType,
  actionType,
  token,
  eventDocument,
  verified,
  pendingRequests,
  lastError,
}: {
  eventId: string;
  actionId: string;
  eventType: string;
  actionType: string;
  token: string;
  eventDocument: Record<string, unknown>;
  verified?: VerifiedResults;
  pendingRequests?: PendingVerificationRequest[];
  lastError: string;
}) => {
  const result = database
    .prepare(
      `INSERT INTO pending_verifications
         (id, event_id, action_id, event_type, action_type, token, event_document, verified, pending_requests, last_error, retry_count, next_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT DO NOTHING`,
    )
    .run(
      pendingVerificationId(eventId, actionId),
      eventId,
      actionId,
      eventType,
      actionType,
      token,
      JSON.stringify(eventDocument),
      verified ? JSON.stringify(verified) : null,
      pendingRequests?.length ? JSON.stringify(pendingRequests) : null,
      lastError,
    );

  return result.changes > 0;
};

export const hasPendingVerificationForEvent = (eventId: string): boolean =>
  database
    .prepare("SELECT 1 FROM pending_verifications WHERE event_id = ? LIMIT 1")
    .get(eventId) !== undefined;

/** Leases claimed jobs so a crash or slow pass cannot double-process them. */
export const claimPendingVerifications = (
  limit: number,
  leaseMinutes: number,
) => {
  const claim = database.transaction(
    (batchSize: number, lease: number): PendingVerificationRow[] => {
      const rows = database
        .prepare(
          `SELECT ${PENDING_VERIFICATION_COLUMNS}
           FROM pending_verifications
           WHERE next_retry_at <= datetime('now')
           ORDER BY retry_count ASC, created_at ASC
           LIMIT ?`,
        )
        .all(batchSize) as PendingVerificationRow[];

      const lease_ = database.prepare(
        `UPDATE pending_verifications
         SET next_retry_at = datetime('now', '+' || CAST(? AS TEXT) || ' minutes'),
             updated_at = datetime('now')
         WHERE id = ?`,
      );

      for (const row of rows) {
        lease_.run(lease, row.id);
      }

      return rows;
    },
  );

  return claim(limit, leaseMinutes).map(toPendingVerification);
};

/** Exponential backoff with jitter, so a backlog does not stampede IDA. */
export const reschedulePendingVerification = (
  id: string,
  error: string,
  backoffBaseMinutes: number,
) => {
  database
    .prepare(
      `UPDATE pending_verifications
       SET retry_count = retry_count + 1,
           last_error = ?,
           next_retry_at = datetime('now',
             '+' || CAST(POWER(2, MIN(retry_count, 10)) * ? AS TEXT) || ' minutes',
             '+' || CAST(ABS(RANDOM()) % 60 AS TEXT) || ' seconds'),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error, backoffBaseMinutes, id);
};

export const removePendingVerification = (id: string) => {
  const result = database
    .prepare("DELETE FROM pending_verifications WHERE id = ?")
    .run(id);

  return result.changes > 0;
};

export const getPendingVerificationById = (id: string) => {
  const row = database
    .prepare(
      `SELECT ${PENDING_VERIFICATION_COLUMNS} FROM pending_verifications WHERE id = ?`,
    )
    .get(id) as PendingVerificationRow | undefined;

  return row ? toPendingVerification(row) : undefined;
};

export const getAllPendingVerifications = (limit = 50) =>
  (
    database
      .prepare(
        `SELECT ${PENDING_VERIFICATION_COLUMNS}
         FROM pending_verifications
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as PendingVerificationRow[]
  ).map(toPendingVerification);

export const countPendingVerifications = () =>
  (
    database
      .prepare("SELECT COUNT(*) AS count FROM pending_verifications")
      .get() as { count: number }
  ).count;
