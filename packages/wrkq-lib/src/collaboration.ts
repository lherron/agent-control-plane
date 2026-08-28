import type { WorkClient, WrkqEnvelope } from '@wrkq/client'

/**
 * ACP's stable collaboration projection over wrkq rooms/envelopes.
 *
 * The concrete adapter is intentionally thin and lives beside the existing
 * @wrkq/client store adapter. Consumers depend on this projection instead of
 * importing wrkq's database-shaped rows or recreating HRC message records.
 */

export type CollaborationAddress = {
  principalRef: string
  scopeRef?: string | undefined
}

export type CollaborationMessage = {
  /** EN-xxxxx friendly id from wrkq. */
  messageId: string
  /** Numeric EN suffix used by the existing mobile message cursor. */
  messageSeq: number
  roomKey: string
  groupId: string
  sender: CollaborationAddress
  recipient?: CollaborationAddress | undefined
  obligation: 'reply_required' | 'fyi' | 'none'
  state: 'pending' | 'presented' | 'acked' | 'deferred' | 'dead'
  body: string
  taskId?: string | undefined
  /** Historical HRC message id retained on pre-flag-day envelopes, when present. */
  legacyMessageId?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CollaborationMessageList = {
  messages: CollaborationMessage[]
  nextCursor?: string | undefined
}

export type CollaborationSayInput = {
  ref: string
  to?: string[] | undefined
  body: string
  fyi?: boolean | undefined
  subject?: string | undefined
  forceNew?: boolean | undefined
  urgent?: boolean | undefined
  respondTo?: string | undefined
  idempotencyKey?: string | undefined
}

export type CollaborationSayReceipt = {
  roomUuid: string
  roomKey: string
  groupId: string
  envelopes: CollaborationMessage[]
}

/** High-level port implemented strictly through @wrkq/client RPC. */
export interface CollaborationLedger {
  listMessagesByMember(input: {
    memberRef: string
    /** Scope-less human principal viewing the returned envelopes through ACP. */
    presentToPrincipalRef?: string | undefined
    beforeMessageSeq?: number | undefined
    limit?: number | undefined
  }): Promise<CollaborationMessageList>
  listMessagesByRoom(input: {
    roomKey: string
    /** Scope-less human principal viewing the returned envelopes through ACP. */
    presentToPrincipalRef?: string | undefined
    beforeMessageSeq?: number | undefined
    limit?: number | undefined
  }): Promise<CollaborationMessageList>
  say(input: CollaborationSayInput): Promise<CollaborationSayReceipt>
}

const LEGACY_MESSAGE_IDEMPOTENCY_PREFIX = 'acp:hrc-message:'

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined) return 80
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`collaboration message limit must be a positive integer: ${limit}`)
  }
  return limit
}

function projectEnvelope(envelope: WrkqEnvelope): CollaborationMessage {
  const obligation = envelope.obligation
  if (obligation !== 'reply_required' && obligation !== 'fyi' && obligation !== 'none') {
    throw new Error(`invalid collaboration obligation on ${envelope.id}: ${obligation}`)
  }
  const state = envelope.state
  if (
    state !== 'pending' &&
    state !== 'presented' &&
    state !== 'acked' &&
    state !== 'deferred' &&
    state !== 'dead'
  ) {
    throw new Error(`invalid collaboration state on ${envelope.id}: ${state}`)
  }
  const legacyMessageId = envelope.idempotencyKey?.startsWith(LEGACY_MESSAGE_IDEMPOTENCY_PREFIX)
    ? envelope.idempotencyKey.slice(LEGACY_MESSAGE_IDEMPOTENCY_PREFIX.length)
    : undefined

  return {
    messageId: envelope.id,
    messageSeq: collaborationMessageSeq(envelope.id),
    roomKey: envelope.roomKey,
    groupId: envelope.groupId ?? envelope.id,
    sender: envelope.from,
    ...(envelope.to !== undefined && envelope.to !== null ? { recipient: envelope.to } : {}),
    obligation,
    state,
    body: envelope.body,
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    ...(legacyMessageId !== undefined && legacyMessageId.length > 0 ? { legacyMessageId } : {}),
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
  }
}

function selectMessages(
  envelopes: WrkqEnvelope[],
  beforeMessageSeq: number | undefined,
  limit: number
): CollaborationMessageList {
  const selected = envelopes
    .map(projectEnvelope)
    .filter((message) => beforeMessageSeq === undefined || message.messageSeq < beforeMessageSeq)
    .sort((lhs, rhs) => {
      const byTime = rhs.createdAt.localeCompare(lhs.createdAt)
      return byTime !== 0 ? byTime : rhs.messageSeq - lhs.messageSeq
    })
  const messages = selected.slice(0, limit)
  const oldest = messages.at(-1)
  return {
    messages,
    ...(selected.length > messages.length && oldest !== undefined
      ? { nextCursor: String(oldest.messageSeq) }
      : {}),
  }
}

async function presentScopeLessHumanEnvelopes(
  client: WorkClient,
  callerPrincipalRef: string,
  envelopes: WrkqEnvelope[],
  humanPrincipalRef: string | undefined
): Promise<WrkqEnvelope[]> {
  if (humanPrincipalRef === undefined) return envelopes
  if (!/^agent:[^\s:]+$/.test(humanPrincipalRef)) {
    throw new Error(
      `human presentation requires an exact agent:<id> principal: ${humanPrincipalRef}`
    )
  }

  return Promise.all(
    envelopes.map(async (envelope) => {
      if (
        envelope.to?.principalRef !== humanPrincipalRef ||
        envelope.to.scopeRef !== undefined ||
        envelope.presentedTo.some((receipt) => receipt.memberRef === humanPrincipalRef)
      ) {
        return envelope
      }
      const result = await client.wrkq.envelope.present({
        envelope: envelope.id,
        memberRef: humanPrincipalRef,
        principalRef: callerPrincipalRef,
      })
      return result.envelope
    })
  )
}

/**
 * Bind ACP's collaboration projection to the Wave-1 typed room facade.
 * Connection-scoped caller attribution stays owned by @wrkq/client; this
 * adapter never sends principalRef/from overrides.
 */
export function createCollaborationLedger(
  client: WorkClient,
  principalRef: string
): CollaborationLedger {
  return {
    async listMessagesByMember(input): Promise<CollaborationMessageList> {
      const limit = normalizedLimit(input.limit)
      const rooms = await client.wrkq.room.list({
        scope: 'me',
        principalRef,
        scopeRef: input.memberRef,
      })
      const histories = await Promise.all(
        rooms.items.map((room) =>
          client.wrkq.room.logView({
            room: room.key,
            principalRef,
            ...(input.beforeMessageSeq === undefined ? { limit } : {}),
          })
        )
      )
      const envelopes = await presentScopeLessHumanEnvelopes(
        client,
        principalRef,
        histories.flatMap((history) => history.items),
        input.presentToPrincipalRef
      )
      return selectMessages(envelopes, input.beforeMessageSeq, limit)
    },

    async listMessagesByRoom(input): Promise<CollaborationMessageList> {
      const limit = normalizedLimit(input.limit)
      const history = await client.wrkq.room.logView({
        room: input.roomKey,
        principalRef,
        ...(input.beforeMessageSeq === undefined ? { limit } : {}),
      })
      const envelopes = await presentScopeLessHumanEnvelopes(
        client,
        principalRef,
        history.items,
        input.presentToPrincipalRef
      )
      return selectMessages(envelopes, input.beforeMessageSeq, limit)
    },

    async say(input): Promise<CollaborationSayReceipt> {
      const receipt = await client.wrkq.room.say({
        ref: input.ref,
        body: input.body,
        principalRef,
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...(input.fyi !== undefined ? { fyi: input.fyi } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.forceNew !== undefined ? { new: input.forceNew } : {}),
        ...(input.urgent !== undefined ? { urgent: input.urgent } : {}),
        ...(input.respondTo !== undefined ? { respondTo: input.respondTo } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      })
      return {
        roomUuid: receipt.room.uuid,
        roomKey: receipt.room.key,
        groupId: receipt.groupId,
        envelopes: receipt.envelopes.map(projectEnvelope),
      }
    },
  }
}

export function collaborationMessageSeq(messageId: string): number {
  const match = /^EN-(\d+)$/.exec(messageId)
  if (match === null) {
    throw new Error(`invalid collaboration envelope id: ${messageId}`)
  }
  const sequence = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`invalid collaboration envelope sequence: ${messageId}`)
  }
  return sequence
}

export function formatCollaborationMessage(message: CollaborationMessage): string {
  const sender = message.sender.scopeRef ?? message.sender.principalRef
  return `[${message.roomKey} · ${sender}]\n${message.body}`
}
