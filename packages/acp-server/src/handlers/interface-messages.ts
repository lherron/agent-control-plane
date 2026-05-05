import type { InterfaceMessageAttachment } from 'acp-core'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import { resolveAttachmentRefs } from '../attachments.js'
import { AcpHttpError, json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalArrayField,
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

function parseOptionalInterfaceMessageAttachments(
  input: Record<string, unknown>
): InterfaceMessageAttachment[] | undefined {
  const entries = readOptionalArrayField(input, 'attachments')
  if (entries === undefined) {
    return undefined
  }

  return entries.map((entry, index) => parseInterfaceMessageAttachment(entry, index))
}

function parseInterfaceMessageAttachment(
  input: unknown,
  index: number
): InterfaceMessageAttachment {
  const field = `attachments[${index}]`
  const attachment = requireRecord(input, field)
  const kind = attachment['kind']
  if (kind !== 'url' && kind !== 'file') {
    throw new AcpHttpError(400, 'bad_request', `${field}.kind must be "url" or "file"`, {
      field: `${field}.kind`,
    })
  }

  const url = readOptionalTrimmedStringField(attachment, 'url')
  const path = readOptionalTrimmedStringField(attachment, 'path')
  if (kind === 'url' && url === undefined) {
    throw new AcpHttpError(400, 'bad_request', `${field}.url is required for url attachments`, {
      field: `${field}.url`,
    })
  }
  if (kind === 'file' && path === undefined) {
    throw new AcpHttpError(400, 'bad_request', `${field}.path is required for file attachments`, {
      field: `${field}.path`,
    })
  }

  const filename = readOptionalTrimmedStringField(attachment, 'filename')
  const contentType = readOptionalTrimmedStringField(attachment, 'contentType')
  const sizeBytes = readOptionalSizeBytes(attachment, `${field}.sizeBytes`)

  return {
    kind,
    ...(url !== undefined ? { url } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(filename !== undefined ? { filename } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  }
}

function readOptionalSizeBytes(input: Record<string, unknown>, field: string): number | undefined {
  const value = input['sizeBytes']
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AcpHttpError(400, 'bad_request', `${field} must be a non-negative safe integer`, {
      field,
    })
  }
  return value
}

function toSessionRef(scopeRef: string, laneRef: string): SessionRef {
  return normalizeSessionRef({ scopeRef, laneRef })
}

export const handleCreateInterfaceMessage: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const source = parseInterfaceSource(body)
  const content = requireTrimmedStringField(body, 'content')
  const attachments = parseOptionalInterfaceMessageAttachments(body)
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
    ...(attachments !== undefined ? { attachments } : {}),
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
  if (createdAttempt.created && deps.conversationStore !== undefined) {
    const thread = deps.conversationStore.createOrGetThread({
      gatewayId: source.gatewayId,
      conversationRef: source.conversationRef,
      ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
      sessionRef,
      audience: 'human',
    })

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
    const resolvedAttachments = await resolveAttachmentRefs(attachments, {
      runId: createdAttempt.runId,
      stateDir: deps.mediaStateDir,
      maxBytes: deps.attachmentMaxBytes,
      fetchImpl: deps.attachmentFetchImpl,
    })
    if (resolvedAttachments !== undefined) {
      const run = deps.runStore.getRun(createdAttempt.runId)
      if (run?.metadata !== undefined) {
        deps.runStore.updateRun(createdAttempt.runId, {
          metadata: {
            ...run.metadata,
            meta: {
              ...readRecord(run.metadata['meta']),
              resolvedAttachments,
            },
          },
        })
      }
    }

    const intent = await resolveLaunchIntent(deps, sessionRef, {
      initialPrompt: content,
      ...(resolvedAttachments !== undefined ? { attachments: resolvedAttachments } : {}),
    })

    await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      acpRunId: createdAttempt.runId,
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      runStore: deps.runStore,
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

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
