import {
  HrcDomainError,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  splitSessionRef,
} from 'hrc-core'
import type { AcpHrcClient } from '../deps.js'
import { badRequest, json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { federatedSessionReadFromStatus, requireHrcClient } from './mobile-hrc.js'
import { latestRuntimeForSession, sessionRef } from './mobile-session-projection.js'

export const REMOTE_CONTROL_UNAVAILABLE_MESSAGE =
  'Remote timeline, history, literal input, and interrupt are unavailable in mobile federation Phase 1.'

export function isRemoteProjectionSource(value: unknown): boolean {
  return value === 'remote_runtime_projection'
}

const FEDERATED_READ_CACHE_MS = 30_000

const federatedReadCache = new WeakMap<object, { value: boolean; at: number }>()

export async function federatedSessionReadDeclared(hrcClient: AcpHrcClient): Promise<boolean> {
  const cached = federatedReadCache.get(hrcClient)
  if (cached !== undefined && Date.now() - cached.at < FEDERATED_READ_CACHE_MS) return cached.value
  if (typeof hrcClient.getStatus !== 'function') return false
  try {
    const value = federatedSessionReadFromStatus(
      await hrcClient.getStatus({ includeSessions: false })
    )
    federatedReadCache.set(hrcClient, { value, at: Date.now() })
    return value
  } catch {
    // An unanswerable status is not a declaration; do not remember it.
    return false
  }
}

/** HRC refusals that say "the home could not answer now", which a client retries. */
export function sessionHomeRefusal(error: unknown): { code: string; message: string } | undefined {
  if (error instanceof HrcDomainError && error.code.startsWith('session_home_')) {
    return { code: error.code, message: error.message }
  }
  return undefined
}

export function remoteControlUnavailable(clientInputId?: string): Response {
  return json(
    {
      ok: false,
      ...(clientInputId !== undefined ? { clientInputId } : {}),
      code: 'remote_control_unavailable',
      message: REMOTE_CONTROL_UNAVAILABLE_MESSAGE,
    },
    422
  )
}

/**
 * Look up a session on the LOCAL hrc node by hostSessionId, plus its latest
 * runtime. Returns undefined when this node does not own the session — callers
 * decide whether that is a 400, a 404, or a routing signal.
 */
export async function findLocalMobileSessionByHostSessionId(
  hrcClient: AcpHrcClient,
  hostSessionId: string
): Promise<
  | {
      record: HrcSessionRecord
      runtime?: HrcRuntimeSnapshot | undefined
    }
  | undefined
> {
  // `all: true` is load-bearing (T-07575). HRC now bounds an unscoped
  // `/v1/sessions` to a recency window for display callers, and this is not a
  // display caller: it backs attach-info, timeline, input and interrupt. Without
  // it, HRCMac could not attach to or open any session older than the window —
  // a bounded view turning into a lost capability. The dashboard's own read
  // (`listMobileSessions`) deliberately stays bounded; that is the fix.
  const records = await hrcClient.listSessions({ all: true })
  const matches = records.filter((candidate) => candidate.hostSessionId === hostSessionId)
  if (matches.length === 0) {
    return undefined
  }
  // Multiple generations may exist for a hostSessionId — pick the highest.
  const record = matches.sort((lhs, rhs) => rhs.generation - lhs.generation)[0] as HrcSessionRecord
  const runtimes = await hrcClient.listRuntimes({ hostSessionId: record.hostSessionId })
  return { record, runtime: latestRuntimeForSession(record, runtimes) }
}

async function resolveMobileSessionByHostSessionId(
  hrcClient: AcpHrcClient,
  hostSessionId: string
): Promise<{
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
}> {
  const resolved = await findLocalMobileSessionByHostSessionId(hrcClient, hostSessionId)
  if (resolved === undefined) {
    badRequest(`session not found: ${hostSessionId}`, { hostSessionId })
  }
  return resolved
}

export type MobileReadSession = {
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
  /** Answered by the scope's home through HRC's federated read, not this node. */
  remote: boolean
}

/**
 * T-10418 §5.2 — the read-only lookup behind timeline open and history ONLY.
 *
 * The local lookup runs first, unchanged. On a local miss with a client
 * `sessionRef` and the declared capability, the canonical continuity is read
 * by scope and lane through HRC's home-routed `sessions/get`, so a local
 * shadow is never selected. The home's active host session must be the one
 * requested (otherwise the generation rolled). Runtime inventory is never
 * consulted, so a runtime-less continuity still resolves. Input and interrupt
 * keep `resolveMobileSessionByHostSessionId` and can never reach this.
 */
export async function resolveMobileSessionForRead(
  hrcClient: AcpHrcClient,
  input: { hostSessionId: string; sessionRef: string | undefined }
): Promise<MobileReadSession> {
  const local = await findLocalMobileSessionByHostSessionId(hrcClient, input.hostSessionId)
  if (local !== undefined) return { ...local, remote: false }
  if (
    input.sessionRef === undefined ||
    hrcClient.getSessionByContinuity === undefined ||
    !(await federatedSessionReadDeclared(hrcClient))
  ) {
    badRequest(`session not found: ${input.hostSessionId}`, {
      hostSessionId: input.hostSessionId,
    })
  }
  const { scopeRef, laneRef } = splitSessionRef(input.sessionRef)
  let canonical: Awaited<ReturnType<NonNullable<AcpHrcClient['getSessionByContinuity']>>>
  try {
    canonical = await hrcClient.getSessionByContinuity({ scopeRef, laneRef })
  } catch (error) {
    if (sessionHomeRefusal(error) !== undefined) throw error
    badRequest(`session not found: ${input.hostSessionId}`, {
      hostSessionId: input.hostSessionId,
    })
  }
  if (canonical.generation.hostSessionId !== input.hostSessionId) {
    badRequest(`session not found: ${input.hostSessionId} (generation rolled)`, {
      hostSessionId: input.hostSessionId,
      currentHostSessionId: canonical.generation.hostSessionId,
    })
  }
  return {
    record: {
      hostSessionId: canonical.generation.hostSessionId,
      scopeRef,
      laneRef,
      generation: canonical.generation.generation,
      status: canonical.generation.status,
      createdAt: canonical.generation.createdAt,
      updatedAt: canonical.facts.lastActivityAt ?? canonical.generation.createdAt,
      ...(canonical.identity !== undefined ? { identity: canonical.identity } : {}),
    } as HrcSessionRecord,
    remote: true,
  }
}

function requireHostSessionIdParam(params: Record<string, string>): string {
  const value = params['hostSessionId']
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest('hostSessionId path segment is required')
  }
  return value
}

export const handleMobileInput: RouteHandler = async ({ deps, request, params }) => {
  const hrcClient = requireHrcClient(deps)
  const hostSessionId = requireHostSessionIdParam(params)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')

  if (isRemoteProjectionSource(body['sourceKind'])) {
    return remoteControlUnavailable(clientInputId)
  }
  const text = requireTrimmedStringField(body, 'text')

  try {
    const { record } = await resolveMobileSessionByHostSessionId(hrcClient, hostSessionId)
    const sessionRefValue = sessionRef(record.scopeRef, record.laneRef)
    await hrcClient.deliverLiteralBySelector({
      selector: { sessionRef: sessionRefValue },
      text,
      enter: body['enter'] !== false,
      ...(typeof body['fences'] === 'object' && body['fences'] !== null
        ? { fences: body['fences'] as never }
        : {}),
    })
    return json({ ok: true, clientInputId, acceptedAt: new Date().toISOString() })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'input_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}

export const handleMobileInterrupt: RouteHandler = async ({ deps, request, params }) => {
  const hrcClient = requireHrcClient(deps)
  const hostSessionId = requireHostSessionIdParam(params)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')

  if (isRemoteProjectionSource(body['sourceKind'])) {
    return remoteControlUnavailable(clientInputId)
  }

  try {
    const { runtime } = await resolveMobileSessionByHostSessionId(hrcClient, hostSessionId)
    if (runtime === undefined) {
      return json(
        { ok: false, clientInputId, code: 'not_interruptible', message: 'No runtime is attached.' },
        422
      )
    }
    await hrcClient.interrupt(runtime.runtimeId)
    return json({ ok: true, clientInputId })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'interrupt_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}
