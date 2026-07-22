import { HrcErrorCode, type HrcMessageRecord } from 'hrc-core'

import type { StoredRun } from './run-store.js'

export type SemanticMessageCorrelation = {
  requestMessageId: string
  rootMessageId: string
  afterSeq: number
  localNodeId?: string | undefined
  homeNodeId?: string | undefined
}

export type SemanticMessageResponse = {
  messageId: string
  body: string
  createdAt: string
}

export type SemanticMessageFailure = {
  code: string
  message: string
  reason: string
  retryable: boolean
  homeNodeId?: string | undefined
}

export type SemanticMessageTerminal =
  | { state: 'completed'; response: SemanticMessageResponse }
  | { state: 'failed'; error: SemanticMessageFailure }

export type ProjectedSemanticMessageRun = StoredRun & {
  response?: SemanticMessageResponse | undefined
  failure?: SemanticMessageFailure | undefined
}

export function readSemanticMessageCorrelation(
  run: StoredRun
): SemanticMessageCorrelation | undefined {
  const semanticMessage = readSemanticMessageRecord(run)
  if (semanticMessage === undefined) {
    return undefined
  }

  const requestMessageId = readString(semanticMessage, 'requestMessageId')
  const rootMessageId = readString(semanticMessage, 'rootMessageId')
  const afterSeq = semanticMessage['afterSeq']
  if (
    requestMessageId === undefined ||
    rootMessageId === undefined ||
    typeof afterSeq !== 'number' ||
    !Number.isSafeInteger(afterSeq) ||
    afterSeq < 0
  ) {
    throw new Error(`run ${run.runId} has invalid HRC semantic message correlation`)
  }

  const localNodeId = readString(semanticMessage, 'localNodeId')
  const homeNodeId = readString(semanticMessage, 'homeNodeId')
  return {
    requestMessageId,
    rootMessageId,
    afterSeq,
    ...(localNodeId !== undefined ? { localNodeId } : {}),
    ...(homeNodeId !== undefined ? { homeNodeId } : {}),
  }
}

export function semanticMessageResponse(record: HrcMessageRecord): SemanticMessageResponse {
  return {
    messageId: record.messageId,
    body: record.body,
    createdAt: record.createdAt,
  }
}

export function normalizeSemanticMessageDeliveryFailure(input: {
  errorCode: string
  errorMessage?: string | undefined
  errorReason?: string | undefined
  retryable?: boolean | undefined
  homeNodeId?: string | undefined
  fallbackHomeNodeId?: string | undefined
}): SemanticMessageFailure {
  const retryable = input.retryable === true
  const code =
    input.errorCode === HrcErrorCode.RUNTIME_UNAVAILABLE || retryable
      ? HrcErrorCode.RUNTIME_UNAVAILABLE
      : HrcErrorCode.STALE_CONTEXT
  const homeNodeId = input.homeNodeId ?? input.fallbackHomeNodeId
  return {
    code,
    message: input.errorMessage ?? 'HRC federation delivery failed',
    reason: input.errorReason ?? input.errorCode,
    retryable,
    ...(homeNodeId !== undefined ? { homeNodeId } : {}),
  }
}

export function semanticMessageTimeoutFailure(input: {
  message: string
  homeNodeId?: string | undefined
}): SemanticMessageFailure {
  return {
    code: 'turn_timeout',
    message: input.message,
    reason: 'response_timeout',
    retryable: false,
    ...(input.homeNodeId !== undefined ? { homeNodeId: input.homeNodeId } : {}),
  }
}

export function metadataWithSemanticMessageTerminal(
  run: StoredRun,
  terminal: SemanticMessageTerminal
): Readonly<Record<string, unknown>> {
  const metadata = isRecord(run.metadata) ? run.metadata : {}
  const meta = isRecord(metadata['meta']) ? metadata['meta'] : {}
  const semanticMessage = readSemanticMessageRecord(run)
  if (semanticMessage === undefined) {
    throw new Error(`run ${run.runId} has no HRC semantic message correlation`)
  }

  return {
    ...metadata,
    meta: {
      ...meta,
      hrcSemanticMessage: {
        ...semanticMessage,
        terminal,
      },
    },
  }
}

export function projectSemanticMessageRun(run: StoredRun): ProjectedSemanticMessageRun {
  const semanticMessage = readSemanticMessageRecord(run)
  const terminal = isRecord(semanticMessage?.['terminal']) ? semanticMessage['terminal'] : undefined
  if (terminal?.['state'] === 'completed') {
    const response = readSemanticMessageResponse(terminal['response'])
    return response === undefined ? run : { ...run, response }
  }
  if (terminal?.['state'] === 'failed') {
    const failure = readSemanticMessageFailure(terminal['error'])
    return failure === undefined ? run : { ...run, failure }
  }
  return run
}

function readSemanticMessageRecord(run: StoredRun): Record<string, unknown> | undefined {
  const metadata = isRecord(run.metadata) ? run.metadata : undefined
  const meta = isRecord(metadata?.['meta']) ? metadata['meta'] : undefined
  return isRecord(meta?.['hrcSemanticMessage']) ? meta['hrcSemanticMessage'] : undefined
}

function readSemanticMessageResponse(input: unknown): SemanticMessageResponse | undefined {
  if (!isRecord(input)) {
    return undefined
  }
  const messageId = readString(input, 'messageId')
  const body = typeof input['body'] === 'string' ? input['body'] : undefined
  const createdAt = readString(input, 'createdAt')
  if (messageId === undefined || body === undefined || createdAt === undefined) {
    return undefined
  }
  return { messageId, body, createdAt }
}

function readSemanticMessageFailure(input: unknown): SemanticMessageFailure | undefined {
  if (!isRecord(input)) {
    return undefined
  }
  const code = readString(input, 'code')
  const message = readString(input, 'message')
  const reason = readString(input, 'reason')
  const retryable = input['retryable']
  if (
    code === undefined ||
    message === undefined ||
    reason === undefined ||
    typeof retryable !== 'boolean'
  ) {
    return undefined
  }
  const homeNodeId = readString(input, 'homeNodeId')
  return {
    code,
    message,
    reason,
    retryable,
    ...(homeNodeId !== undefined ? { homeNodeId } : {}),
  }
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}
