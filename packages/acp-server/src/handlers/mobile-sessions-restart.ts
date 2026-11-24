import { randomUUID } from 'node:crypto'
import { badRequest, json } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'
import { callSeatRestart, requestSeatRestart } from '../seat-restart-client.js'

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

export const handleMobileRestart: RouteHandler = async ({ deps, request, params }) => {
  const { hrcClient } = deps
  if (hrcClient === undefined) badRequest('hrcClient not configured')
  const hostSessionId = params['hostSessionId']?.trim() ?? ''
  if (hostSessionId === '') badRequest('hostSessionId path segment is required')
  const expectedGeneration = parseFences(requireRecord(await parseJsonBody(request)), hostSessionId)
  try {
    const session = await hrcClient.getSession(hostSessionId)
    const target = {
      seat: `${session.scopeRef}/lane:${session.laneRef.replace(/^lane:/, '') || 'main'}`,
      idempotencyKey: randomUUID(),
    }
    const result = await requestSeatRestart(
      deps.seatRestartCall ?? callSeatRestart,
      'seat-restart.cold',
      { ...target, when: 'now', expectedHostSessionId: hostSessionId, expectedGeneration },
      { ...target, reconcile: true }
    )
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
  } catch (error) {
    return refusal(error)
  }
}
