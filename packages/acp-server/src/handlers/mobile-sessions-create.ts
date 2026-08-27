import { createHash } from 'node:crypto'

import {
  buildScopeRef,
  formatScopeHandle,
  formatSessionRef,
  normalizeSessionRef,
  parseScopeRef,
  validateToken,
} from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeIntent, RestartStyle, StartRuntimeRequest } from 'hrc-core'
import { buildHrcRuntimeIntent } from 'hrc-sdk'

import { json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'

const IDEMPOTENCY_KEY_PREFIX = 'acp-mobile-session:v1:'
const DEFAULT_MOBILE_TASK_ID = 'primary'
const ALLOWED_FIELDS = new Set(['agentId', 'projectId', 'taskId', 'viewerWindow', 'requestId'])
const MOBILE_RESTART_STYLE: RestartStyle = 'reuse_pty'

/**
 * The quick-pick lanes the mobile roster owns. Pressing one of these means
 * "give me a free session near this lane", so a collision walks the suffix
 * roster (`primary` -> `primary-nova`) instead of failing.
 */
const ROSTER_MOBILE_TASK_IDS = new Set(['primary', 'minisvc', 'minilab'])

type MobileSessionErrorCode =
  | 'session_roster_exhausted'
  | 'idempotency_key_conflict'
  | 'roster_claim_superseded'
  | 'session_scope_occupied'

const MOBILE_SESSION_ERROR_MESSAGES: Record<MobileSessionErrorCode, string> = {
  session_roster_exhausted: 'too many open sessions',
  idempotency_key_conflict: 'requestId was reused for a different session request',
  roster_claim_superseded: 'try again',
  session_scope_occupied: 'that scope is already open',
}

function assertAllowedFields(body: Record<string, unknown>): void {
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, `unexpected field ${field}`, {
        field,
      })
    }
  }
}

export function deriveMobileSessionIdempotencyKey(requestId: string): string {
  const digest = createHash('sha256').update(requestId, 'utf8').digest('hex')
  return `${IDEMPOTENCY_KEY_PREFIX}${digest}`
}

/**
 * Mobile clients pick a session scope by task token — the well-known operator
 * lanes (primary, minisvc, minilab, hrcdev) and any task the operator types by
 * hand. There is no server-side allowlist: the only constraint is the canonical
 * agent-scope token grammar, checked here so a malformed token is rejected at
 * the MALFORMED_REQUEST boundary rather than escaping as an untyped ScopeRef
 * parse failure downstream.
 */
export function resolveMobileTaskId(body: Record<string, unknown>): string {
  const taskId = readOptionalTrimmedStringField(body, 'taskId') ?? DEFAULT_MOBILE_TASK_ID
  const tokenError = validateToken(taskId, 'taskId')
  if (tokenError !== undefined) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, tokenError, { field: 'taskId' })
  }
  return taskId
}

export type MobileSessionConflictPolicy = 'suffix' | 'reject'

/**
 * Quick-pick roster lanes keep the suffix family; anything the operator typed
 * by hand — including the pinned `hrcdev` lane — names ONE exact scope, so it
 * claims that scope or is refused. There is no next slot to walk and no reuse
 * of somebody else's live conversation.
 */
export function resolveMobileConflictPolicy(taskId: string): MobileSessionConflictPolicy {
  return ROSTER_MOBILE_TASK_IDS.has(taskId) ? 'suffix' : 'reject'
}

/**
 * ACP names the scope and nothing else: `summonIntent: 'implicit'` leaves HRC
 * to resolve where that scope lives from policy and registry state, so no node
 * assertion crosses this boundary in either shape.
 */
export function buildMobileStartRequest(input: {
  conflictPolicy: MobileSessionConflictPolicy
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  idempotencyKey: string
}): StartRuntimeRequest {
  if (input.conflictPolicy === 'suffix') {
    return {
      baseSessionRef: input.sessionRef,
      runtimeIntent: input.runtimeIntent,
      conflictPolicy: 'suffix',
      summonIntent: 'implicit',
      idempotencyKey: input.idempotencyKey,
      restartStyle: MOBILE_RESTART_STYLE,
    }
  }
  return {
    sessionRef: input.sessionRef,
    runtimeIntent: input.runtimeIntent,
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: input.idempotencyKey,
    restartStyle: MOBILE_RESTART_STYLE,
  }
}

function isMobileSessionErrorCode(code: string): code is MobileSessionErrorCode {
  return code in MOBILE_SESSION_ERROR_MESSAGES
}

function mobileSessionErrorResponse(input: {
  error: HrcDomainError
  requestId: string
  agentId: string
  projectId: string
  taskId: string
}): Response | undefined {
  if (!isMobileSessionErrorCode(input.error.code)) return undefined

  if (input.error.code === HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT) {
    console.error(
      `[acp-server] ${JSON.stringify({
        event: 'mobile.session.idempotency_key_conflict',
        requestId: input.requestId,
        agentId: input.agentId,
        projectId: input.projectId,
        taskId: input.taskId,
        details: input.error.detail,
      })}`
    )
  }

  return json(
    {
      ok: false,
      requestId: input.requestId,
      code: input.error.code,
      message: MOBILE_SESSION_ERROR_MESSAGES[input.error.code],
    },
    409
  )
}

export const handleCreateMobileSession: RouteHandler = async ({ deps, request }) => {
  if (deps.hrcClient === undefined) {
    throw new Error('acp-server hrcClient: no HRC client wired')
  }

  const body = requireRecord(await parseJsonBody(request))
  assertAllowedFields(body)
  const agentId = requireTrimmedStringField(body, 'agentId')
  const projectId = requireTrimmedStringField(body, 'projectId')
  const requestId = requireTrimmedStringField(body, 'requestId')
  const taskId = resolveMobileTaskId(body)
  // T-07603: no service default. HRC derives placement from scope shape, so a
  // mobile session lands in the operator's interactive window without ACP naming
  // a window at all. An explicit client-supplied key is still forwarded and still
  // overrides the derived placement.
  const viewerWindow = readOptionalTrimmedStringField(body, 'viewerWindow')

  const baseScopeRef = buildScopeRef({ agentId, projectId, taskId })
  // parseScopeRef is the token/grammar validation boundary for the separate
  // agentId and projectId request fields before any placement or HRC call.
  parseScopeRef(baseScopeRef)
  const baseSession = normalizeSessionRef({ scopeRef: baseScopeRef, laneRef: 'main' })
  const baseIntent = await resolveLaunchIntent(deps, baseSession)
  const inferredIntent = buildHrcRuntimeIntent({
    agentId,
    agentRoot: baseIntent.placement.agentRoot,
    ...(baseIntent.placement.projectRoot !== undefined
      ? { projectRoot: baseIntent.placement.projectRoot }
      : {}),
    cwd: baseIntent.placement.cwd,
    runMode: baseIntent.placement.runMode,
    interactive: true,
    preferredMode: 'headless',
  })
  const runtimeIntent = {
    ...baseIntent,
    harness: inferredIntent.harness,
    execution: inferredIntent.execution,
    ...(viewerWindow !== undefined ? { presentation: { viewerWindow } } : {}),
  }

  const conflictPolicy = resolveMobileConflictPolicy(taskId)

  try {
    const started = await deps.hrcClient.startRuntime(
      buildMobileStartRequest({
        conflictPolicy,
        sessionRef: formatSessionRef(baseSession),
        runtimeIntent,
        idempotencyKey: deriveMobileSessionIdempotencyKey(requestId),
      })
    )
    // Both claim-and-start shapes report the scope they actually claimed; the
    // response DTO is projected from that claim, never from what ACP asked for.
    if (started.claim === undefined) {
      throw new Error(`HRC ${conflictPolicy} start response did not include the claimed session`)
    }

    return json({
      claimedScope: formatScopeHandle(parseScopeRef(started.claim.scopeRef)),
      sessionRef: started.claim.sessionRef,
      hostSessionId: started.hostSessionId,
      runtimeId: started.runtimeId,
      status: started.status,
      replayed: started.claim.replayed,
    })
  } catch (error) {
    if (error instanceof HrcDomainError) {
      const mapped = mobileSessionErrorResponse({
        error,
        requestId,
        agentId,
        projectId,
        taskId,
      })
      if (mapped !== undefined) return mapped
    }
    throw error
  }
}
