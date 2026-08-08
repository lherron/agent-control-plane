import { createHash } from 'node:crypto'

import {
  buildScopeRef,
  formatScopeHandle,
  formatSessionRef,
  normalizeSessionRef,
  parseScopeRef,
} from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
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

const DEFAULT_MOBILE_VIEWER_WINDOW = 'console'
const MOBILE_VIEWER_WINDOW_ENV = 'ACP_MOBILE_VIEWER_WINDOW'
const IDEMPOTENCY_KEY_PREFIX = 'acp-mobile-session:v1:'
const ALLOWED_FIELDS = new Set(['agentId', 'projectId', 'viewerWindow', 'requestId'])

type MobileSessionErrorCode =
  | 'session_roster_exhausted'
  | 'idempotency_key_conflict'
  | 'roster_claim_superseded'

const MOBILE_SESSION_ERROR_MESSAGES: Record<MobileSessionErrorCode, string> = {
  session_roster_exhausted: 'too many open sessions',
  idempotency_key_conflict: 'requestId was reused for a different session request',
  roster_claim_superseded: 'try again',
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

export function resolveConfiguredMobileViewerWindow(env: NodeJS.ProcessEnv = process.env): string {
  return env[MOBILE_VIEWER_WINDOW_ENV]?.trim() || DEFAULT_MOBILE_VIEWER_WINDOW
}

// Deployment configuration is captured once when acp-server loads. It is not
// re-read from ambient process state per request: request intent comes only from
// the explicit viewerWindow field, while this value is the stable service default.
const CONFIGURED_MOBILE_VIEWER_WINDOW = resolveConfiguredMobileViewerWindow()

export function resolveMobileViewerWindow(
  requested: string | undefined,
  configuredDefault = CONFIGURED_MOBILE_VIEWER_WINDOW
): string {
  return requested ?? configuredDefault
}

function isMobileSessionErrorCode(code: string): code is MobileSessionErrorCode {
  return code in MOBILE_SESSION_ERROR_MESSAGES
}

function mobileSessionErrorResponse(input: {
  error: HrcDomainError
  requestId: string
  agentId: string
  projectId: string
}): Response | undefined {
  if (!isMobileSessionErrorCode(input.error.code)) return undefined

  if (input.error.code === HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT) {
    console.error(
      `[acp-server] ${JSON.stringify({
        event: 'mobile.session.idempotency_key_conflict',
        requestId: input.requestId,
        agentId: input.agentId,
        projectId: input.projectId,
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
  const viewerWindow = resolveMobileViewerWindow(
    readOptionalTrimmedStringField(body, 'viewerWindow')
  )

  const baseScopeRef = buildScopeRef({ agentId, projectId, taskId: 'primary' })
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
    presentation: { viewerWindow },
  }

  try {
    const started = await deps.hrcClient.startRuntime({
      baseSessionRef: formatSessionRef(baseSession),
      runtimeIntent,
      conflictPolicy: 'suffix',
      idempotencyKey: deriveMobileSessionIdempotencyKey(requestId),
      restartStyle: 'reuse_pty',
    })
    if (started.claim === undefined) {
      throw new Error('HRC suffix start response did not include the claimed session')
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
      const mapped = mobileSessionErrorResponse({ error, requestId, agentId, projectId })
      if (mapped !== undefined) return mapped
    }
    throw error
  }
}
