import { randomUUID } from 'node:crypto'

import type {
  CreateOutboundAttachmentInput,
  OutboundAttachment,
  OutboundAttachmentState,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type OutboundAttachmentRow = {
  outboundAttachmentId: string
  runId: string
  state: OutboundAttachmentState
  consumedByDeliveryRequestId: string | null
  path: string
  filename: string
  contentType: string
  sizeBytes: number
  alt: string | null
  createdAt: string
  updatedAt: string
}

function mapOutboundAttachmentRow(row: OutboundAttachmentRow): OutboundAttachment {
  return {
    outboundAttachmentId: row.outboundAttachmentId,
    runId: row.runId,
    state: row.state,
    consumedByDeliveryRequestId: toOptionalString(row.consumedByDeliveryRequestId),
    path: row.path,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    alt: toOptionalString(row.alt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class OutboundAttachmentRepo {
  constructor(private readonly context: RepoContext) {}

  create(input: CreateOutboundAttachmentInput): OutboundAttachment {
    const timestamp = input.createdAt ?? new Date().toISOString()
    const outboundAttachmentId =
      input.outboundAttachmentId ?? `oa_${randomUUID().replace(/-/g, '').slice(0, 16)}`

    this.context.sqlite
      .prepare(
        `INSERT INTO outbound_attachments (
           outboundAttachmentId,
           runId,
           state,
           consumedByDeliveryRequestId,
           path,
           filename,
           contentType,
           sizeBytes,
           alt,
           createdAt,
           updatedAt
         ) VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        outboundAttachmentId,
        input.runId,
        input.path,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.alt ?? null,
        timestamp,
        timestamp
      )

    return this.require(outboundAttachmentId)
  }

  get(outboundAttachmentId: string): OutboundAttachment | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT outboundAttachmentId,
                runId,
                state,
                consumedByDeliveryRequestId,
                path,
                filename,
                contentType,
                sizeBytes,
                alt,
                createdAt,
                updatedAt
           FROM outbound_attachments
          WHERE outboundAttachmentId = ?`
      )
      .get(outboundAttachmentId) as OutboundAttachmentRow | undefined

    return row === undefined ? undefined : mapOutboundAttachmentRow(row)
  }

  require(outboundAttachmentId: string): OutboundAttachment {
    const attachment = this.get(outboundAttachmentId)
    if (attachment === undefined) {
      throw new Error(`outbound attachment not found: ${outboundAttachmentId}`)
    }

    return attachment
  }

  listForRun(runId: string): OutboundAttachment[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT outboundAttachmentId,
                runId,
                state,
                consumedByDeliveryRequestId,
                path,
                filename,
                contentType,
                sizeBytes,
                alt,
                createdAt,
                updatedAt
           FROM outbound_attachments
          WHERE runId = ?
          ORDER BY createdAt ASC, outboundAttachmentId ASC`
      )
      .all(runId) as OutboundAttachmentRow[]

    return rows.map(mapOutboundAttachmentRow)
  }

  listPendingForRun(runId: string): OutboundAttachment[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT outboundAttachmentId,
                runId,
                state,
                consumedByDeliveryRequestId,
                path,
                filename,
                contentType,
                sizeBytes,
                alt,
                createdAt,
                updatedAt
           FROM outbound_attachments
          WHERE runId = ?
            AND state = 'pending'
          ORDER BY createdAt ASC, outboundAttachmentId ASC`
      )
      .all(runId) as OutboundAttachmentRow[]

    return rows.map(mapOutboundAttachmentRow)
  }

  markConsumedForRun(runId: string, deliveryRequestId: string, updatedAt: string): number {
    const result = this.context.sqlite
      .prepare(
        `UPDATE outbound_attachments
            SET state = 'consumed',
                consumedByDeliveryRequestId = ?,
                updatedAt = ?
          WHERE runId = ?
            AND state = 'pending'`
      )
      .run(deliveryRequestId, updatedAt, runId)

    return result.changes
  }

  markPendingFailedForRun(runId: string, updatedAt: string): number {
    const result = this.context.sqlite
      .prepare(
        `UPDATE outbound_attachments
            SET state = 'failed',
                updatedAt = ?
          WHERE runId = ?
            AND state = 'pending'`
      )
      .run(updatedAt, runId)

    return result.changes
  }
}
