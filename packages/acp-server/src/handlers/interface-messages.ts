import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import { createInterfaceResponseCapture } from '../delivery/interface-response-capture.js'
import { AcpHttpError, json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

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

export const handleCreateInterfaceMessage: RouteHandler = async ({ request, deps }) => {
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
    actor: { agentId: source.authorRef },
    metadata: inputMetadata,
    runStore: deps.runStore,
  })

  if (createdAttempt.created && deps.launchRoleScopedRun !== undefined) {
    const intent = await resolveLaunchIntent(deps, sessionRef, { initialPrompt: content })
    await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      onEvent: createInterfaceResponseCapture({
        interfaceStore: deps.interfaceStore,
        runStore: deps.runStore,
        runId: createdAttempt.runId,
        inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      }),
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
