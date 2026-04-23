import { parseScopeRef } from 'agent-scope'

import { createInterfaceResponseCapture } from '../delivery/interface-response-capture.js'
import { json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalBooleanField,
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

export const handleCreateInput: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const actor = context.actor ?? deps.defaultActor
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const content = requireTrimmedStringField(body, 'content')
  const metadata = readOptionalMeta(body)
  const dispatch = readOptionalBooleanField(body, 'dispatch')

  const result = deps.inputAttemptStore.createAttempt({
    sessionRef,
    ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
    ...(typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].trim().length > 0
      ? { idempotencyKey: body['idempotencyKey'].trim() }
      : {}),
    content,
    actor,
    ...(metadata !== undefined ? { metadata } : {}),
    runStore: deps.runStore,
  })

  if (result.created && dispatch !== false && deps.launchRoleScopedRun !== undefined) {
    const intent = await resolveLaunchIntent(deps, sessionRef, { initialPrompt: content })
    await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      acpRunId: result.runId,
      inputAttemptId: result.inputAttempt.inputAttemptId,
      runStore: deps.runStore,
      ...(shouldCaptureInterfaceResponses(deps, metadata)
        ? {
            onEvent: createInterfaceResponseCapture({
              interfaceStore: deps.interfaceStore,
              runStore: deps.runStore,
              runId: result.runId,
              inputAttemptId: result.inputAttempt.inputAttemptId,
            }),
          }
        : {}),
    })
  }

  const run = deps.runStore.getRun(result.runId)
  if (run === undefined) {
    throw new Error(`run not found after input creation: ${result.runId}`)
  }

  return json(
    {
      inputAttempt: result.inputAttempt,
      run,
    },
    result.created ? 201 : 200
  )
}
