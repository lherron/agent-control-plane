import { parseScopeRef } from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { json } from '../http.js'
import type { RouteContext } from '../routing/route-context.js'
import { callSeatRestart, requestSeatRestart } from '../seat-restart-client.js'
import { restartRefusal } from './mobile-sessions-restart.js'
import { formatSessionIdentityHandle } from './shared.js'

export type MobileForceRequest =
  | { mode: 'new_context' }
  | { mode: 'reconcile' }
  | { mode: 'launch_successor'; expectedHostSessionId: string; expectedGeneration: number }

const FORCE_TASK_ID = 'primary'
function malformed(message: string, field: string): never {
  throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, message, { field })
}

export function parseMobileForce(
  body: Record<string, unknown>,
  taskId: string
): MobileForceRequest | undefined {
  const raw = body['force']
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    malformed('force must be an object', 'force')
  }
  if (taskId !== FORCE_TASK_ID) malformed('force is only supported for the primary scope', 'force')
  const force = raw as Record<string, unknown>
  const mode = force['mode']
  if (mode !== 'new_context' && mode !== 'reconcile' && mode !== 'launch_successor') {
    malformed('force.mode must be new_context, reconcile or launch_successor', 'force.mode')
  }
  const allowed =
    mode === 'launch_successor' ? ['mode', 'expectedHostSessionId', 'expectedGeneration'] : ['mode']
  for (const key of Object.keys(force)) {
    if (!allowed.includes(key)) malformed(`unexpected field force.${key}`, `force.${key}`)
  }
  if (mode !== 'launch_successor') return { mode }
  const expectedHostSessionId = force['expectedHostSessionId']
  const expectedGeneration = force['expectedGeneration']
  if (typeof expectedHostSessionId !== 'string' || expectedHostSessionId.trim() === '') {
    malformed('force.expectedHostSessionId is required', 'force.expectedHostSessionId')
  }
  if (typeof expectedGeneration !== 'number' || !Number.isInteger(expectedGeneration)) {
    malformed('force.expectedGeneration is required', 'force.expectedGeneration')
  }
  return {
    mode,
    expectedHostSessionId: (expectedHostSessionId as string).trim(),
    expectedGeneration: expectedGeneration as number,
  }
}

export async function handleForcePrimary(input: {
  deps: RouteContext['deps']
  force: MobileForceRequest
  requestId: string
  sessionRef: string
  initialPrompt: string | undefined
  model: string | undefined
}): Promise<Response> {
  const { force, requestId, initialPrompt, model } = input
  const target = { seat: input.sessionRef, idempotencyKey: requestId }
  const reconcile = { ...target, mode: 'reconcile' }
  try {
    const result = await requestSeatRestart(
      input.deps.seatRestartCall ?? callSeatRestart,
      'seat-restart.force',
      {
        ...target,
        ...force,
        ...(force.mode !== 'reconcile' && model !== undefined ? { provision: { model } } : {}),
        ...(force.mode !== 'reconcile' && initialPrompt !== undefined
          ? { firstTurn: initialPrompt }
          : {}),
      },
      reconcile
    )
    if (
      result.outcome === 'unknown' ||
      result.outcome === 'armed' ||
      result.outcome === 'pending'
    ) {
      return json(
        {
          ok: false,
          requestId,
          code: 'force_outcome_unknown',
          message:
            'HRC did not confirm the force outcome; check the live primary before forcing again',
          detail: { active: result.outcome === 'unknown' ? (result.active ?? null) : null },
        },
        502
      )
    }
    const { launch, firstTurn } = result
    return json({
      disposition: result.outcome,
      claimedScope: formatSessionIdentityHandle(result.scopeRef, parseScopeRef(result.scopeRef)),
      sessionRef: result.sessionRef,
      hostSessionId: result.hostSessionId,
      generation: result.generation,
      priorHostSessionId: result.priorHostSessionId,
      launch,
      ...(launch.status === 'started' ? { runtimeId: launch.runtimeId, status: 'started' } : {}),
      replayed: result.replayed ?? false,
      ...(firstTurn?.delivered === true
        ? {
            initialPrompt: {
              delivered: true,
              runId: firstTurn.runId,
              submissionId: firstTurn.submissionId,
            },
          }
        : initialPrompt !== undefined || firstTurn !== undefined
          ? {
              initialPrompt: { delivered: false, reason: firstTurn?.reason ?? 'runtime_not_fresh' },
            }
          : {}),
    })
  } catch (error) {
    const refused = restartRefusal(error)
    return json({ ...refused.body, requestId }, refused.status)
  }
}
