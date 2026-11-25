import { randomUUID } from 'node:crypto'
import { badRequest, json } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'
import {
  type SeatRestartResult,
  callSeatHandoff,
  callSeatRestart,
  effectUnknown,
  requestSeatRestart,
} from '../seat-restart-client.js'

const MOBILE_CODES: Record<string, { code: string; status: number }> = {
  runtime_busy: { code: 'session_busy', status: 409 },
  seat_unobservable: { code: 'seat_unobservable', status: 409 },
  model_not_preserved: { code: 'model_not_preserved', status: 409 },
  idempotency_key_conflict: { code: 'idempotency_key_conflict', status: 409 },
  session_scope_occupied: { code: 'session_scope_occupied', status: 409 },
  roster_claim_superseded: { code: 'roster_claim_superseded', status: 409 },
  remote_scope_unsupported: { code: 'remote_scope_unsupported', status: 422 },
  not_authorized: { code: 'not_authorized', status: 403 },
  stale_context: { code: 'stale_context', status: 409 },
  missing_runtime_intent: { code: 'not_restartable', status: 422 },
}

type HrcErrorLike = { code: string; message: string; detail?: Record<string, unknown> }

function isHrcErrorLike(error: unknown): error is HrcErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

/** Map an HRC restart refusal to the mobile code the leaf and the phone act on. */
export function restartRefusal(error: unknown): { status: number; body: Record<string, unknown> } {
  if (!isHrcErrorLike(error)) {
    return {
      status: 502,
      body: {
        ok: false,
        code: 'restart_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const detail = error.detail ?? {}
  const mapped =
    detail['reason'] === 'participant_rotation_unsupported'
      ? { code: 'not_restartable', status: 422 }
      : (MOBILE_CODES[error.code] ?? { code: error.code, status: 502 })
  return {
    status: mapped.status,
    body: { ok: false, code: mapped.code, message: error.message, detail },
  }
}

function refusal(error: unknown): Response {
  const refused = restartRefusal(error)
  return json(refused.body, refused.status)
}

function parseFences(body: Record<string, unknown>, hostSessionId: string): number {
  const fences = body['fences']
  if (fences === null || typeof fences !== 'object' || Array.isArray(fences)) {
    badRequest('fences.expectedGeneration is required', { field: 'fences' })
  }
  const record = fences as Record<string, unknown>
  const expectedHostSessionId = record['expectedHostSessionId']
  if (expectedHostSessionId !== undefined && expectedHostSessionId !== hostSessionId) {
    badRequest('fences.expectedHostSessionId does not match the path', {
      field: 'fences.expectedHostSessionId',
    })
  }
  const expectedGeneration = record['expectedGeneration']
  if (typeof expectedGeneration !== 'number' || !Number.isInteger(expectedGeneration)) {
    badRequest('fences.expectedGeneration is required', { field: 'fences.expectedGeneration' })
  }
  return expectedGeneration as number
}

type Mode = 'fresh' | 'handoff' | 'recap'

type RestartRequest = {
  mode: Mode | undefined
  requestId: string | undefined
  reconcile: boolean
}

function parseRestartRequest(body: Record<string, unknown>): RestartRequest {
  const mode = body['mode']
  if (mode !== undefined && mode !== 'fresh' && mode !== 'handoff' && mode !== 'recap') {
    badRequest('mode must be fresh, handoff or recap', { field: 'mode' })
  }
  const requestId = body['requestId']
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.trim() === '')) {
    badRequest('requestId must be a nonempty string', { field: 'requestId' })
  }
  const reconcile = body['reconcile']
  if (reconcile !== undefined && reconcile !== true) {
    badRequest('reconcile must be true when given', { field: 'reconcile' })
  }
  if (mode === 'handoff' && (requestId !== undefined || reconcile === true)) {
    badRequest('handoff has no replay key: send neither requestId nor reconcile', {
      field: requestId !== undefined ? 'requestId' : 'reconcile',
    })
  }
  if (mode === 'recap' && requestId === undefined) {
    badRequest('recap requires requestId', { field: 'requestId' })
  }
  if (reconcile === true && (mode === undefined || requestId === undefined)) {
    badRequest('reconcile requires mode and requestId', { field: 'reconcile' })
  }
  return {
    mode: mode as Mode | undefined,
    requestId: (requestId as string | undefined)?.trim(),
    reconcile: reconcile === true,
  }
}

/** The legacy response, for a request without `mode`: shipped phones read it. */
function legacyResponse(result: SeatRestartResult): Response {
  if (result.outcome !== 'restarted') {
    return json(
      { ok: false, code: 'restart_failed', message: 'HRC did not confirm the restart' },
      502
    )
  }
  return json({
    ok: true,
    priorHostSessionId: result.priorHostSessionId,
    hostSessionId: result.hostSessionId,
    generation: result.generation,
    launch: result.launch,
    summonDirectives: result.summonDirectives,
  })
}

function modeResponse(mode: 'fresh' | 'recap', requestId: string, result: SeatRestartResult) {
  if (result.outcome === 'armed') return json({ ok: true, mode, outcome: 'armed', requestId })
  if (result.outcome !== 'restarted') {
    // unknown, pending after reconcile, or an outcome this route does not serve.
    return json({ ok: false, mode, outcome: 'unknown', requestId }, 202)
  }
  return json({
    ok: true,
    mode,
    outcome: 'restarted',
    requestId,
    priorHostSessionId: result.priorHostSessionId,
    hostSessionId: result.hostSessionId,
    generation: result.generation,
    launch: result.launch,
    ...(result.summonDirectives !== undefined ? { summonDirectives: result.summonDirectives } : {}),
    // Recap: whether the recap prompt reached the successor as its first turn.
    // Delivery is not a read; the seat answers in its own transcript.
    ...(result.firstTurn !== undefined ? { firstTurn: result.firstTurn } : {}),
  })
}

export const handleMobileRestart: RouteHandler = async ({ deps, request, params }) => {
  const { hrcClient } = deps
  if (hrcClient === undefined) badRequest('hrcClient not configured')
  const hostSessionId = params['hostSessionId']?.trim() ?? ''
  if (hostSessionId === '') badRequest('hostSessionId path segment is required')
  const body = requireRecord(await parseJsonBody(request))
  const { mode, requestId, reconcile } = parseRestartRequest(body)
  // A reconcile only reads a stored outcome, so it needs no fence.
  const expectedGeneration = reconcile ? undefined : parseFences(body, hostSessionId)
  try {
    const session = await hrcClient.getSession(hostSessionId)
    const seat = `${session.scopeRef}/lane:${session.laneRef.replace(/^lane:/, '') || 'main'}`
    const fence = { expectedHostSessionId: hostSessionId, expectedGeneration }

    if (mode === 'handoff') {
      // Unkeyed literal input: never reconciled or resent here.
      try {
        const input = await (deps.seatHandoffCall ?? callSeatHandoff)({ seat, ...fence })
        return json({ ok: true, mode, outcome: 'prompt_accepted', input })
      } catch (error) {
        if (effectUnknown(error)) return json({ ok: false, mode, outcome: 'unknown' }, 202)
        throw error
      }
    }

    const operation = mode === 'recap' ? 'seat-restart.recap' : 'seat-restart.cold'
    const key = requestId ?? randomUUID()
    const call = deps.seatRestartCall ?? callSeatRestart
    const reconcileArgs = { seat, idempotencyKey: key, reconcile: true }
    if (reconcile) {
      const result = await call(operation, reconcileArgs)
      return modeResponse(mode as 'fresh' | 'recap', key, result)
    }
    const result = await requestSeatRestart(
      call,
      operation,
      { seat, idempotencyKey: key, ...(mode === 'recap' ? {} : { when: 'now' }), ...fence },
      reconcileArgs
    )
    return mode === undefined ? legacyResponse(result) : modeResponse(mode, key, result)
  } catch (error) {
    return refusal(error)
  }
}
