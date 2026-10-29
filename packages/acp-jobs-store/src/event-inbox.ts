import { claimWithLease } from './lease-claims.js'
import { type InboxEventRow, toInboxEventRecord } from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  ClaimInboxEventsInput,
  InboxEventRecord,
  InsertInboxEventInput,
} from './store-contracts.js'

/** Default page size for pending inbox-event claim queries. */
const DEFAULT_INBOX_CLAIM_LIMIT = 50

export function createEventInbox(sqlite: SqliteDatabase) {
  // --- Webhook event-job primitives ---------------------------------------

  const getInboxEvent = (eventId: string): { event: InboxEventRecord | undefined } => {
    const row = sqlite.prepare('SELECT * FROM event_inbox WHERE event_id = ?').get(eventId) as
      | InboxEventRow
      | undefined
    return { event: row === undefined ? undefined : toInboxEventRecord(row) }
  }

  const insertInboxEvent = (
    input: InsertInboxEventInput
  ): { event: InboxEventRecord; inserted: boolean } => {
    const now = new Date().toISOString()
    const source = input.source ?? 'wrkq'
    const canonicalEventId = `${source}:${input.eventId}`
    const result = sqlite
      .prepare(
        `
          INSERT OR IGNORE INTO event_inbox (
            event_id, event_seq, source, event, occurred_at, payload_json,
            status, attempts, received_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `
      )
      .run(
        canonicalEventId,
        input.eventSeq,
        source,
        input.event,
        input.occurredAt ?? null,
        JSON.stringify(input.payload),
        input.receivedAt ?? now,
        now,
        now
      )
    const event = getInboxEvent(canonicalEventId).event
    if (event === undefined) {
      throw new Error(`event inbox row not found after insert: ${canonicalEventId}`)
    }
    return { event, inserted: result.changes > 0 }
  }

  const claimPendingInboxEvents = (input: ClaimInboxEventsInput): InboxEventRecord[] => {
    const limit = input.limit ?? DEFAULT_INBOX_CLAIM_LIMIT
    return claimWithLease<{ event_id: string }, InboxEventRecord>(sqlite, {
      selectSql: `
            SELECT event_id
            FROM event_inbox
            WHERE status = 'pending'
               OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
            ORDER BY event_seq ASC
            LIMIT ?
          `,
      selectParams: [input.now, limit],
      claimSql: `
              UPDATE event_inbox
              SET status = 'leased',
                  lease_owner = ?,
                  lease_expires_at = ?,
                  attempts = attempts + 1,
                  updated_at = ?
              WHERE event_id = ?
                AND (
                  status = 'pending'
                  OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                )
            `,
      claimParams: (candidate) => [
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        candidate.event_id,
        input.now,
      ],
      reread: (candidate) => getInboxEvent(candidate.event_id).event,
    })
  }

  const markInboxEventProcessed = (eventId: string, now?: string | undefined): void => {
    const ts = now ?? new Date().toISOString()
    sqlite
      .prepare(
        `
          UPDATE event_inbox
          SET status = 'processed', processed_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE event_id = ?
        `
      )
      .run(ts, ts, eventId)
  }

  const markInboxEventFailed = (eventId: string, error: string, now?: string | undefined): void => {
    const ts = now ?? new Date().toISOString()
    sqlite
      .prepare(
        `
          UPDATE event_inbox
          SET status = 'failed', last_error = ?, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = ?
          WHERE event_id = ?
        `
      )
      .run(error, ts, eventId)
  }
  return {
    getInboxEvent,
    insertInboxEvent,
    claimPendingInboxEvents,
    markInboxEventProcessed,
    markInboxEventFailed,
  }
}
