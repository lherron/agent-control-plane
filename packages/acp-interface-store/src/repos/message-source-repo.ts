import type { InterfaceMessageSource, RecordIfNewMessageSourceResult } from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type InterfaceMessageSourceRow = {
  gateway_id: string
  message_ref: string
  binding_id: string
  conversation_ref: string
  thread_ref: string | null
  author_ref: string
  received_at: string
}

function mapInterfaceMessageSourceRow(row: InterfaceMessageSourceRow): InterfaceMessageSource {
  return {
    gatewayId: row.gateway_id,
    messageRef: row.message_ref,
    bindingId: row.binding_id,
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    authorRef: row.author_ref,
    receivedAt: row.received_at,
  }
}

export class MessageSourceRepo {
  constructor(private readonly context: RepoContext) {}

  recordIfNew(messageSource: InterfaceMessageSource): RecordIfNewMessageSourceResult {
    const result = this.context.sqlite
      .prepare(
        `INSERT OR IGNORE INTO interface_message_sources (
           gateway_id,
           message_ref,
           binding_id,
           conversation_ref,
           thread_ref,
           author_ref,
           received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageSource.gatewayId,
        messageSource.messageRef,
        messageSource.bindingId,
        messageSource.conversationRef,
        messageSource.threadRef ?? null,
        messageSource.authorRef,
        messageSource.receivedAt
      )

    return {
      created: result.changes > 0,
      record: this.requireByMessageRef(messageSource.gatewayId, messageSource.messageRef),
    }
  }

  getByMessageRef(gatewayId: string, messageRef: string): InterfaceMessageSource | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT gateway_id,
                message_ref,
                binding_id,
                conversation_ref,
                thread_ref,
                author_ref,
                received_at
           FROM interface_message_sources
          WHERE gateway_id = ?
            AND message_ref = ?`
      )
      .get(gatewayId, messageRef) as InterfaceMessageSourceRow | undefined

    return row === undefined ? undefined : mapInterfaceMessageSourceRow(row)
  }

  private requireByMessageRef(gatewayId: string, messageRef: string): InterfaceMessageSource {
    const messageSource = this.getByMessageRef(gatewayId, messageRef)
    if (messageSource === undefined) {
      throw new Error(`Failed to reload interface message source ${gatewayId}:${messageRef}`)
    }

    return messageSource
  }
}
