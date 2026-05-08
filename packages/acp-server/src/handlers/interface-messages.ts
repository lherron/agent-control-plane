import type { AttachmentRef, InputIntent, InterfaceMessageAttachment } from 'acp-core'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import { resolveAttachmentRefs } from '../attachments.js'
import { createInterfaceResponseCapture } from '../delivery/interface-response-capture.js'
import { toCompletedVisibleAssistantMessage } from '../delivery/visible-assistant-messages.js'
import { AcpHttpError, badRequest, json } from '../http.js'
import { InputAdmissionService } from '../input-admission/input-admission-service.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalArrayField,
  readOptionalRecordField,
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

function readIntent(body: Record<string, unknown>): InputIntent | undefined {
  const intent = readOptionalRecordField(body, 'intent')
  if (intent === undefined) {
    return undefined
  }

  const kind = intent['kind']
  switch (kind) {
    case 'new_work': {
      const resetPolicy = intent['resetPolicy']
      if (
        resetPolicy !== undefined &&
        resetPolicy !== 'follow_latest' &&
        resetPolicy !== 'expire_on_generation_change' &&
        resetPolicy !== 'pin_generation'
      ) {
        badRequest(
          'intent.resetPolicy must be follow_latest, expire_on_generation_change, or pin_generation',
          { field: 'intent.resetPolicy' }
        )
      }
      return {
        kind,
        ...(resetPolicy !== undefined ? { resetPolicy } : {}),
      }
    }
    case 'contribute_to_active_run': {
      const fallback = intent['fallback'] ?? 'queue'
      if (fallback !== 'queue' && fallback !== 'reject' && fallback !== 'pending_only') {
        badRequest('intent.fallback must be queue, reject, or pending_only', {
          field: 'intent.fallback',
        })
      }
      const semantics = intent['contributionSemantics']
      if (
        semantics !== undefined &&
        semantics !== 'append_context' &&
        semantics !== 'interrupt_and_continue'
      ) {
        badRequest(
          'intent.contributionSemantics must be append_context or interrupt_and_continue',
          {
            field: 'intent.contributionSemantics',
          }
        )
      }
      return {
        kind,
        fallback,
        ...(semantics !== undefined ? { contributionSemantics: semantics } : {}),
      }
    }
    case 'control_active_run': {
      const action = intent['action']
      if (action !== 'interrupt' && action !== 'cancel' && action !== 'pause') {
        badRequest('intent.action must be interrupt, cancel, or pause', { field: 'intent.action' })
      }
      const fallback = intent['fallback']
      if (fallback !== undefined && fallback !== 'reject') {
        badRequest('intent.fallback must be reject when provided', { field: 'intent.fallback' })
      }
      return {
        kind,
        action,
        ...(fallback !== undefined ? { fallback } : {}),
      }
    }
    default:
      badRequest('intent.kind must be new_work, contribute_to_active_run, or control_active_run', {
        field: 'intent.kind',
      })
  }
}

function toSessionRef(scopeRef: string, laneRef: string): SessionRef {
  return normalizeSessionRef({ scopeRef, laneRef })
}

/**
 * Append a footer to the prompt listing each resolved attachment's local file
 * path so non-image-aware harnesses can read the file with their tool surface.
 * No-op when there are no file-kind attachments.
 */
function appendAttachmentPathsToPrompt(
  prompt: string,
  resolved: AttachmentRef[] | undefined
): string {
  if (resolved === undefined || resolved.length === 0) return prompt
  const filePaths = resolved
    .filter((a): a is AttachmentRef & { path: string } => a.kind === 'file' && !!a.path)
    .map((a) => `[attached file: ${a.path}]`)
  if (filePaths.length === 0) return prompt
  return `${prompt}\n\n${filePaths.join('\n')}`
}

export const handleCreateInterfaceMessage: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const source = parseInterfaceSource(body)
  const content = requireTrimmedStringField(body, 'content')
  const attachments = parseOptionalInterfaceMessageAttachments(body)
  const intent = readIntent(body)
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
  const inputActor = { kind: 'human' as const, id: source.authorRef }
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

  let conversationThreadId: string | undefined

  const admissionResult = await new InputAdmissionService(deps).admit({
    sessionRef,
    ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
    idempotencyKey: `interface:${source.gatewayId}:${source.messageRef}`,
    content,
    actor: inputActor,
    metadata: inputMetadata,
    ...(intent !== undefined ? { intent } : {}),
    dispatch: false,
  })
  const createdAttempt = {
    inputAttempt: admissionResult.inputAttempt,
    runId: admissionResult.run?.runId,
    targetRunId: admissionResult.targetRun?.runId,
    created: admissionResult.created,
  }
  if (
    createdAttempt.runId === undefined &&
    admissionResult.admission.admissionKind !== 'accepted_in_flight' &&
    admissionResult.admission.admissionKind !== 'admission_pending' &&
    admissionResult.admission.admissionKind !== 'rejected'
  ) {
    throw new Error(
      `interface admission did not create a run: ${createdAttempt.inputAttempt.inputAttemptId}`
    )
  }
  const admittedRunId = createdAttempt.runId

  // Conversation hook: create human turn after input attempt creation
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

  let launched: Awaited<ReturnType<NonNullable<typeof deps.launchRoleScopedRun>>> | undefined

  if (createdAttempt.created && admittedRunId !== undefined) {
    const resolvedAttachments = await resolveAttachmentRefs(attachments, {
      runId: admittedRunId,
      stateDir: deps.mediaStateDir,
      maxBytes: deps.attachmentMaxBytes,
      fetchImpl: deps.attachmentFetchImpl,
    })
    if (resolvedAttachments !== undefined) {
      const run = deps.runStore.getRun(admittedRunId)
      if (run?.metadata !== undefined) {
        deps.runStore.updateRun(admittedRunId, {
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
  }

  if (
    createdAttempt.created &&
    admittedRunId !== undefined &&
    admissionResult.admission.admissionKind === 'started_run' &&
    deps.launchRoleScopedRun !== undefined
  ) {
    const run = deps.runStore.getRun(admittedRunId)
    const resolvedAttachments =
      ((run?.metadata?.['meta'] as Record<string, unknown> | undefined)?.['resolvedAttachments'] as
        | AttachmentRef[]
        | undefined) ?? undefined

    // Augment the prompt with resolved file paths so agents on harnesses that
    // don't natively inject image content blocks (claude-agent-sdk today) can
    // still see attached files via their Read tool. Codex agents get images
    // through the `-i` CLI flag separately and are unaffected by this hint.
    const promptWithAttachmentPaths = appendAttachmentPathsToPrompt(content, resolvedAttachments)

    const intent = await resolveLaunchIntent(deps, sessionRef, {
      initialPrompt: promptWithAttachmentPaths,
      ...(resolvedAttachments !== undefined ? { attachments: resolvedAttachments } : {}),
    })
    const responseCapture = createInterfaceResponseCapture({
      interfaceStore: deps.interfaceStore,
      runStore: deps.runStore,
      runId: admittedRunId,
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
    })

    launched = await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      acpRunId: admittedRunId,
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      runStore: deps.runStore,
      waitForCompletion: false,
      onEvent: async (event) => {
        await responseCapture.handler(event)

        const deliveryRequestId = responseCapture.lastDeliveryRequestId
        if (deliveryRequestId === undefined || deps.conversationStore === undefined) {
          return
        }

        const visible = toCompletedVisibleAssistantMessage(event)
        if (visible === undefined) {
          return
        }

        const threadId =
          conversationThreadId ??
          deps.conversationStore.createOrGetThread({
            gatewayId: source.gatewayId,
            conversationRef: source.conversationRef,
            ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
            sessionRef,
            audience: 'human',
          }).threadId
        const turnId = deps.conversationStore.createTurn({
          threadId,
          role: 'assistant',
          body: visible.text,
          renderState: 'pending',
          links: { runId: admittedRunId },
          actor,
          sentAt: new Date().toISOString(),
        })

        deps.conversationStore.attachLinks(turnId, { deliveryRequestId })
      },
    })
  }

  const run = admittedRunId !== undefined ? deps.runStore.getRun(admittedRunId) : undefined
  const hostSessionId = run?.hostSessionId ?? launched?.hostSessionId
  const generation = run?.generation ?? launched?.generation
  const includeAdmissionDetails =
    admittedRunId === undefined ||
    admissionResult.admission.admissionKind === 'accepted_in_flight' ||
    admissionResult.admission.admissionKind === 'admission_pending' ||
    admissionResult.admission.admissionKind === 'rejected'

  return json(
    {
      inputAttemptId: createdAttempt.inputAttempt.inputAttemptId,
      ...(admittedRunId !== undefined ? { runId: admittedRunId } : {}),
      ...(createdAttempt.targetRunId !== undefined
        ? { targetRunId: createdAttempt.targetRunId }
        : {}),
      ...(includeAdmissionDetails
        ? {
            admission: admissionResult.admission.originalResponse,
            currentState: admissionResult.currentState,
          }
        : {}),
      ...(hostSessionId !== undefined ? { hostSessionId } : {}),
      ...(generation !== undefined ? { generation } : {}),
    },
    createdAttempt.created ? 201 : 200
  )
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
