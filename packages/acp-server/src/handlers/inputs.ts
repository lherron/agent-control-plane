import { parseScopeRef } from 'agent-scope'

import type { InputIntent } from 'acp-core'
import { createInterfaceResponseCapture } from '../delivery/interface-response-capture.js'
import { badRequest, json } from '../http.js'
import { InputAdmissionService } from '../input-admission/input-admission-service.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalBooleanField,
  readOptionalRecordField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { parseSessionRefField, readOptionalMeta } from './shared.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

function readNonEmptyString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function shouldCaptureInterfaceResponses(
  deps: ResolvedAcpServerDeps,
  metadata: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (!isRecord(metadata)) {
    return false
  }

  const interfaceSource = metadata['interfaceSource']
  if (!isRecord(interfaceSource)) {
    return false
  }

  const bindingId = readNonEmptyString(interfaceSource, 'bindingId')
  if (bindingId === undefined) {
    return false
  }

  if (
    readNonEmptyString(interfaceSource, 'gatewayId') === undefined ||
    readNonEmptyString(interfaceSource, 'conversationRef') === undefined ||
    readNonEmptyString(interfaceSource, 'messageRef') === undefined
  ) {
    return false
  }

  return deps.interfaceStore.bindings.getById(bindingId)?.status === 'active'
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

export const handleCreateInput: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const actor = context.actor ?? deps.defaultActor
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const content = requireTrimmedStringField(body, 'content')
  const metadata = readOptionalMeta(body)
  const dispatch = readOptionalBooleanField(body, 'dispatch')
  const intent = readIntent(body)

  const result = await new InputAdmissionService(deps).admit({
    sessionRef,
    ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
    ...(typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].trim().length > 0
      ? { idempotencyKey: body['idempotencyKey'].trim() }
      : {}),
    content,
    actor,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(intent !== undefined ? { intent } : {}),
    dispatch,
    launch: {
      initialPrompt: content,
      ...(shouldCaptureInterfaceResponses(deps, metadata)
        ? {
            createOnEvent: ({ runId, inputAttemptId }) =>
              createInterfaceResponseCapture({
                interfaceStore: deps.interfaceStore,
                runStore: deps.runStore,
                runId,
                inputAttemptId,
              }).handler,
          }
        : {}),
    },
  })

  if (
    result.run === undefined &&
    result.targetRun === undefined &&
    result.admission.admissionKind !== 'rejected' &&
    result.admission.admissionKind !== 'admission_pending' &&
    result.admission.admissionKind !== 'accepted_in_flight'
  ) {
    throw new Error(`run not found after input admission: ${result.inputAttempt.inputAttemptId}`)
  }

  return json(
    {
      inputAttempt: result.inputAttempt,
      ...(result.run !== undefined ? { run: result.run } : {}),
      ...(result.targetRun !== undefined ? { targetRun: result.targetRun } : {}),
      ...(result.inputApplication !== undefined
        ? { inputApplication: result.inputApplication }
        : {}),
      admission: result.admission.originalResponse,
      currentState: result.currentState,
    },
    result.created ? 201 : 200
  )
}
