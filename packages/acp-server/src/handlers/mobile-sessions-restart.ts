import { badRequest, json } from '../http.js'
import { expireQueuedInput, isPendingQueueItem } from '../input-admission/expire-queued-input.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'

import type { AcpHrcClient } from '../deps.js'
import type { RouteContext, RouteHandler } from '../routing/route-context.js'

/**
 * T-10850 — `POST /v1/mobile/sessions/:hostSessionId/restart` (ADR hrc-ios
 * architecture/adr/2026-10-14-semantic-session-restart.md).
 *
 * HRCMac's restart hotkey: end the leaf's conversation and relaunch the same
 * scope fresh. HRC decides first; every HRC refusal passes through and ACP
 * mutates nothing. Only after HRC commits does ACP expire the input composed
 * for the dropped context: items fenced to the prior host session, plus
 * unfenced items queued before this request arrived. Input fenced to the
 * successor, or arriving after the request, is never touched. This route
 * never forces (Lance, 2026-10-14); the only mobile force is the explicit
 * "Force new session" on create (T-10942, mobile-force-primary.ts).
 */

const MOBILE_CODES: Record<string, { code: string; status: number }> = {
  runtime_busy: { code: 'session_busy', status: 409 },
  seat_unobservable: { code: 'seat_unobservable', status: 409 },
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

/**
 * After HRC commits a restart, expire the input composed for the dropped
 * context: items fenced to the prior host, plus unfenced items queued before
 * the request arrived. `follow_latest`, successor-fenced and later input survive.
 */
export function expireInputComposedForDroppedContext(
  deps: RouteContext['deps'],
  input: { scopeRef: string; laneRef: string; priorHostSessionId: string; receivedAt: string }
): void {
  for (const item of deps.inputQueueStore.listForSession(input.scopeRef, input.laneRef)) {
    if (item.resetPolicy === 'follow_latest' || !isPendingQueueItem(item)) continue
    const composedForDropped =
      item.expectedHostSessionId === undefined
        ? item.createdAt < input.receivedAt
        : item.expectedHostSessionId === input.priorHostSessionId
    if (composedForDropped) {
      expireQueuedInput(deps, item, 'queued input expired because the session was restarted')
    }
  }
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
  const hrcClient = deps.hrcClient as AcpHrcClient | undefined
  if (hrcClient === undefined) badRequest('hrcClient not configured')
  const hostSessionId = params['hostSessionId']?.trim() ?? ''
  if (hostSessionId === '') badRequest('hostSessionId path segment is required')
  const expectedGeneration = parseFences(requireRecord(await parseJsonBody(request)), hostSessionId)
  const receivedAt = new Date().toISOString()

  if (hrcClient.restartSession === undefined) {
    return json(
      {
        ok: false,
        code: 'restart_unsupported',
        message: 'this ACP build predates HRC session restart',
      },
      501
    )
  }

  let session: Awaited<ReturnType<AcpHrcClient['getSession']>>
  let restarted: Awaited<ReturnType<NonNullable<AcpHrcClient['restartSession']>>>
  try {
    session = await hrcClient.getSession(hostSessionId)
    restarted = await hrcClient.restartSession({ hostSessionId, expectedGeneration })
  } catch (error) {
    return refusal(error)
  }

  expireInputComposedForDroppedContext(deps, {
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    priorHostSessionId: restarted.priorHostSessionId,
    receivedAt,
  })

  return json({ ok: true, ...restarted })
}
