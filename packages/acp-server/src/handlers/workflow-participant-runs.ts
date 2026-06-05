import type { Actor } from 'acp-core'
import { normalizeSessionRef, parseSessionRef } from 'agent-scope'

import { AcpHttpError, json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { actorRefFromUnknown } from '../workflow-runtime.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
import { launchParticipant } from '../wrkf/participant-launch.js'

export const handleCreateWorkflowParticipantRun: RouteHandler = async ({ request, deps }) => {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  if (deps.launchRoleScopedRun === undefined) {
    throw new AcpHttpError(503, 'HRC_LAUNCHER_UNAVAILABLE', 'HRC runtime launcher not available')
  }

  const body = requireRecord(await parseJsonBody(request))
  const taskId = requireTrimmedStringField(body, 'taskId')
  const role = requireTrimmedStringField(body, 'role')
  const actor = body['actor'] === undefined ? undefined : parseParticipantActor(body['actor'])
  const sessionRef = parseParticipantSessionRef(body, actor)

  try {
    const result = await launchParticipant(
      {
        wrkf,
        runStore: deps.runStore,
        launchRoleScopedRun: deps.launchRoleScopedRun,
        ...(deps.runtimeResolver !== undefined ? { runtimeResolver: deps.runtimeResolver } : {}),
        ...(deps.agentRootResolver !== undefined
          ? { agentRootResolver: deps.agentRootResolver }
          : {}),
        ...(deps.adminStore !== undefined ? { adminStore: deps.adminStore } : {}),
      },
      {
        taskId,
        role,
        ...(actor !== undefined ? { actor } : {}),
        idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
        sessionRef,
        ...(readOptionalTrimmedStringField(body, 'initialPrompt') !== undefined
          ? { initialPrompt: readOptionalTrimmedStringField(body, 'initialPrompt') }
          : {}),
      }
    )

    return json(result, result.replay ? 200 : 201)
  } catch (error) {
    throw mapWrkfError(error)
  }
}

export const handleCompleteWorkflowParticipantRun: RouteHandler = async ({
  request,
  params,
  deps,
}) => {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }

  const runId = requireRunId(params)
  const body = requireRecord(await parseJsonBody(request))
  const summary = readOptionalTrimmedStringField(body, 'summary')

  try {
    const run = await wrkf.run.finish({
      runId,
      status: 'completed',
      ...(summary !== undefined ? { summary } : {}),
    })
    return json({ source: 'wrkf', run }, 200)
  } catch (error) {
    throw mapWrkfError(error)
  }
}

export const handleFailWorkflowParticipantRun: RouteHandler = async ({ request, params, deps }) => {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }

  const runId = requireRunId(params)
  const body = requireRecord(await parseJsonBody(request))
  const reason = requireTrimmedStringField(body, 'reason')
  const classification = readOptionalTrimmedStringField(body, 'classification')
  const summary =
    classification === undefined ? reason : `${reason}\n\nclassification: ${classification}`

  try {
    const run = await wrkf.run.fail({ runId, summary })
    return json({ source: 'wrkf', run }, 200)
  } catch (error) {
    throw mapWrkfError(error)
  }
}

function parseParticipantSessionRef(body: Record<string, unknown>, actor: Actor | undefined) {
  const sessionRef = body['sessionRef']
  if (typeof sessionRef === 'string' && sessionRef.trim().length > 0) {
    return parseSessionRefString(sessionRef)
  }
  if (sessionRef !== undefined) {
    const raw = requireRecord(sessionRef, 'sessionRef')
    const laneRef = readOptionalTrimmedStringField(raw, 'laneRef')
    return normalizeSessionRef({
      scopeRef: requireTrimmedStringField(raw, 'scopeRef'),
      ...(laneRef !== undefined ? { laneRef } : {}),
    })
  }

  const scopeRef = readOptionalTrimmedStringField(body, 'scopeRef')
  if (scopeRef !== undefined) {
    return normalizeSessionRef({
      scopeRef,
      laneRef: readOptionalTrimmedStringField(body, 'laneRef') ?? 'main',
    })
  }

  const agentId = actor?.kind === 'agent' ? actor.id : 'acp-local'
  return normalizeSessionRef({ scopeRef: `agent:${agentId}`, laneRef: 'main' })
}

function parseParticipantActor(input: unknown): Actor {
  const actor = actorRefFromUnknown(input)
  if (actor.kind === 'service' || actor.kind === 'group') {
    throw new AcpHttpError(
      400,
      'malformed_request',
      `actor.kind ${actor.kind} is not supported here`
    )
  }
  return actor
}

function parseSessionRefString(input: string) {
  const trimmed = input.trim()
  const shorthandIndex = trimmed.lastIndexOf('~')
  if (shorthandIndex > 0) {
    return normalizeSessionRef({
      scopeRef: trimmed.slice(0, shorthandIndex),
      laneRef: trimmed.slice(shorthandIndex + 1),
    })
  }
  return parseSessionRef(trimmed)
}

function requireRunId(params: Record<string, string | undefined>): string {
  const runId = params['runId']
  if (runId === undefined || runId.length === 0) {
    throw new AcpHttpError(400, 'malformed_request', 'runId route parameter is required')
  }
  return runId
}

function mapWrkfError(error: unknown): unknown {
  if (isWrkfError(error)) {
    return new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
  }
  return error
}

function isWrkfError(error: unknown): error is Error & { code: string } {
  const candidate = error as { code?: unknown }
  return error instanceof Error && typeof candidate.code === 'string' && candidate.code.length > 0
}
