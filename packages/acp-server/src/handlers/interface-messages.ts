import type { Actor } from 'acp-core'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import {
  type InterfaceResponseCaptureHandler,
  createInterfaceResponseCapture,
} from '../delivery/interface-response-capture.js'
import { toCompletedVisibleAssistantMessage } from '../delivery/visible-assistant-messages.js'
import { AcpHttpError, json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { UnifiedSessionEvent } from 'spaces-runtime'
import type { ConversationStore } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

type ParsedInterfaceSource = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  messageRef: string
  authorRef: string
}

function parseInterfaceSource(input: Record<string, unknown>): ParsedInterfaceSource {
  const source = requireRecord(input['source'], 'source')
  const threadRef = readOptionalTrimmedStringField(source, 'threadRef')

  return {
    gatewayId: requireTrimmedStringField(source, 'gatewayId'),
    conversationRef: requireTrimmedStringField(source, 'conversationRef'),
    ...(threadRef !== undefined ? { threadRef } : {}),
    messageRef: requireTrimmedStringField(source, 'messageRef'),
    authorRef: requireTrimmedStringField(source, 'authorRef'),
  }
}

function toSessionRef(scopeRef: string, laneRef: string): SessionRef {
  return normalizeSessionRef({ scopeRef, laneRef })
}

function wrapOnEventWithConversationHook(
  baseHandler: InterfaceResponseCaptureHandler,
  conversationStore: ConversationStore,
  threadId: string,
  runId: string,
  actor: Actor
): (event: UnifiedSessionEvent) => void | Promise<void> {
  const deliveredMessageIds = new Set<string>()

  return async (event: UnifiedSessionEvent): Promise<void> => {
    await baseHandler(event)

    const visible = toCompletedVisibleAssistantMessage(event)
    if (visible === undefined) {
      return
    }
    if (visible.messageId !== undefined) {
      if (deliveredMessageIds.has(visible.messageId)) {
        return
      }
      deliveredMessageIds.add(visible.messageId)
    }

    conversationStore.createTurn({
      threadId,
      role: 'assistant',
      body: visible.text,
      renderState: 'pending',
      links: { runId },
      actor,
      sentAt: new Date().toISOString(),
    })
  }
}

export const handleCreateInterfaceMessage: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const source = parseInterfaceSource(body)
  const content = requireTrimmedStringField(body, 'content')
  const binding = deps.interfaceStore.bindings.resolve({
    gatewayId: source.gatewayId,
    conversationRef: source.conversationRef,
    ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
  })

  if (binding === undefined) {
    throw new AcpHttpError(404, 'interface_binding_not_found', 'interface binding not found', {
      gatewayId: source.gatewayId,
      conversationRef: source.conversationRef,
      ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
    })
  }

  const sessionRef = toSessionRef(binding.scopeRef, binding.laneRef)
  const actor = context.actor ?? deps.defaultActor
  const timestamp = new Date().toISOString()
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const inputMetadata = {
    interfaceSource: {
      gatewayId: source.gatewayId,
      bindingId: binding.bindingId,
      conversationRef: source.conversationRef,
      ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
      messageRef: source.messageRef,
      authorRef: source.authorRef,
      replyToMessageRef: source.messageRef,
      ...(readOptionalTrimmedStringField(body, 'idempotencyKey') !== undefined
        ? { clientIdempotencyKey: readOptionalTrimmedStringField(body, 'idempotencyKey') }
        : {}),
    },
  } satisfies Readonly<Record<string, unknown>>

  deps.interfaceStore.messageSources.recordIfNew({
    gatewayId: source.gatewayId,
    bindingId: binding.bindingId,
    conversationRef: source.conversationRef,
    ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
    messageRef: source.messageRef,
    authorRef: source.authorRef,
    receivedAt: timestamp,
  })

  const createdAttempt = deps.inputAttemptStore.createAttempt({
    sessionRef,
    ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
    idempotencyKey: `interface:${source.gatewayId}:${source.messageRef}`,
    content,
    actor,
    metadata: inputMetadata,
    runStore: deps.runStore,
  })

  // Conversation hook: create human turn after input attempt creation
  let conversationThreadId: string | undefined
  if (createdAttempt.created && deps.conversationStore !== undefined) {
    const thread = deps.conversationStore.createOrGetThread({
      gatewayId: source.gatewayId,
      conversationRef: source.conversationRef,
      ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
      sessionRef,
      audience: 'human',
    })
    conversationThreadId = thread.threadId

    deps.conversationStore.createTurn({
      threadId: thread.threadId,
      role: 'human',
      body: content,
      renderState: 'delivered',
      links: { inputAttemptId: createdAttempt.inputAttempt.inputAttemptId },
      actor: { kind: 'human', id: source.authorRef },
      sentAt: timestamp,
    })
  }

  if (createdAttempt.created && deps.launchRoleScopedRun !== undefined) {
    const intent = await resolveLaunchIntent(deps, sessionRef, { initialPrompt: content })

    const baseOnEvent = createInterfaceResponseCapture({
      interfaceStore: deps.interfaceStore,
      runStore: deps.runStore,
      runId: createdAttempt.runId,
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
    })

    // Wrap the onEvent handler to also create assistant turns
    const onEvent =
      deps.conversationStore !== undefined && conversationThreadId !== undefined
        ? wrapOnEventWithConversationHook(
            baseOnEvent,
            deps.conversationStore,
            conversationThreadId,
            createdAttempt.runId,
            actor
          )
        : baseOnEvent

    await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      acpRunId: createdAttempt.runId,
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      runStore: deps.runStore,
      onEvent,
    })
  }

  return json(
    {
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      runId: createdAttempt.runId,
    },
    createdAttempt.created ? 201 : 200
  )
}
