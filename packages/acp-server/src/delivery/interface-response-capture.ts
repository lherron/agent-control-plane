import { randomUUID } from 'node:crypto'

import type { Run } from 'acp-core'
import type { InterfaceStore } from 'acp-interface-store'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { RunStore } from '../domain/run-store.js'

import { toCompletedVisibleAssistantMessage } from './visible-assistant-messages.js'

type InterfaceRunSource = {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  messageRef: string
  replyToMessageRef?: string | undefined
}

type InterfaceRunDeliveryContext = {
  run: Run
  source: InterfaceRunSource
}

export interface InterfaceResponseCaptureDeps {
  interfaceStore: InterfaceStore
  runStore: RunStore
  runId: string
  inputAttemptId?: string | undefined
}

export type InterfaceResponseCaptureHandler = (event: UnifiedSessionEvent) => void | Promise<void>

export type InterfaceResponseCapture = {
  handler: InterfaceResponseCaptureHandler
  /** The deliveryRequestId produced by the most recent handler invocation, or undefined. */
  lastDeliveryRequestId: string | undefined
}

export function createInterfaceResponseCapture(
  deps: InterfaceResponseCaptureDeps
): InterfaceResponseCapture {
  let cachedContext: InterfaceRunDeliveryContext | null | undefined
  let deliveryOrdinal = 0
  let replyAnchorConsumed = false
  const deliveredMessageIds = new Set<string>()

  const result: InterfaceResponseCapture = {
    lastDeliveryRequestId: undefined,

    handler: async (event: UnifiedSessionEvent): Promise<void> => {
      try {
        result.lastDeliveryRequestId = undefined

        const visibleMessage = toCompletedVisibleAssistantMessage(event)
        if (visibleMessage === undefined) {
          return
        }

        if (visibleMessage.messageId !== undefined) {
          if (deliveredMessageIds.has(visibleMessage.messageId)) {
            return
          }
          deliveredMessageIds.add(visibleMessage.messageId)
        }

        const context = resolveDeliveryContext(deps.runStore, deps.runId, cachedContext)
        cachedContext = context ?? null
        if (context === undefined) {
          return
        }

        deliveryOrdinal += 1
        const deliveryRequestId = createDeliveryRequestId(deps.runId, deliveryOrdinal)
        deps.interfaceStore.deliveries.enqueue({
          deliveryRequestId,
          actor: context.run.actor,
          gatewayId: context.source.gatewayId,
          bindingId: context.source.bindingId,
          scopeRef: context.run.scopeRef,
          laneRef: context.run.laneRef,
          runId: context.run.runId,
          ...(deps.inputAttemptId !== undefined ? { inputAttemptId: deps.inputAttemptId } : {}),
          conversationRef: context.source.conversationRef,
          ...(context.source.threadRef !== undefined
            ? { threadRef: context.source.threadRef }
            : {}),
          ...(!replyAnchorConsumed
            ? {
                replyToMessageRef: context.source.replyToMessageRef ?? context.source.messageRef,
              }
            : {}),
          bodyKind: 'text/markdown',
          bodyText: visibleMessage.text,
          createdAt: new Date().toISOString(),
        })

        replyAnchorConsumed = true
        result.lastDeliveryRequestId = deliveryRequestId
      } catch (error) {
        console.error(
          `[acp-server] interface response capture skipped for run ${deps.runId}:`,
          error
        )
      }
    },
  }

  return result
}

function createDeliveryRequestId(runId: string, ordinal: number): string {
  return `dr_${runId}_${ordinal.toString().padStart(4, '0')}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function resolveDeliveryContext(
  runStore: RunStore,
  runId: string,
  cachedContext: InterfaceRunDeliveryContext | null | undefined
): InterfaceRunDeliveryContext | undefined {
  if (cachedContext !== undefined) {
    return cachedContext ?? undefined
  }

  const run = runStore.getRun(runId)
  if (run === undefined) {
    throw new Error(`run ${runId} not found for interface response capture`)
  }

  const source = readInterfaceRunSource(run)
  if (source === undefined) {
    return undefined
  }

  return { run, source }
}

function readInterfaceRunSource(run: Run): InterfaceRunSource | undefined {
  const metadata = run.metadata
  if (!isRecord(metadata)) {
    return undefined
  }

  const meta = metadata['meta']
  if (!isRecord(meta)) {
    return undefined
  }

  const interfaceSource = meta['interfaceSource']
  if (!isRecord(interfaceSource)) {
    return undefined
  }

  const threadRef = readOptionalString(interfaceSource, 'threadRef')
  const replyToMessageRef = readOptionalString(interfaceSource, 'replyToMessageRef')

  return {
    gatewayId: readRequiredString(interfaceSource, 'gatewayId'),
    bindingId: readRequiredString(interfaceSource, 'bindingId'),
    conversationRef: readRequiredString(interfaceSource, 'conversationRef'),
    ...(threadRef !== undefined ? { threadRef } : {}),
    messageRef: readRequiredString(interfaceSource, 'messageRef'),
    ...(replyToMessageRef !== undefined ? { replyToMessageRef } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`interface response capture metadata missing ${field}`)
  }

  return value
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`interface response capture metadata has invalid ${field}`)
  }

  return value
}
