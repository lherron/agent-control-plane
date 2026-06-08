import { createHash } from 'node:crypto'

import { AcpHttpError, json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'
import type { RouteContext } from '../routing/route-context.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
import type { PbcHarnessPort } from '../wrkf/pbc-harness.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

export function requirePbcTaskParam(params: Record<string, string | undefined>): string {
  const task = params['task']
  if (task === undefined || task.length === 0) {
    throw new AcpHttpError(400, 'malformed_request', 'task route parameter is required')
  }
  return task
}

export function requireWrkf(deps: RouteContext['deps']) {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  return wrkf
}

export function requirePbcHarnessPort(deps: RouteContext['deps']): PbcHarnessPort {
  const wrkf = requireWrkf(deps)
  return {
    next: (params) => wrkf.next(params),
    evidence: wrkf.evidence,
    obligation: wrkf.obligation,
    captures: readCaptures(wrkf) ?? deps.pbcCaptureStore,
    run: wrkf.run,
    transition: wrkf.transition,
    effect: wrkf.effect,
  } as PbcHarnessPort
}

export function mapPbcRouteError(error: unknown): unknown {
  // Already-shaped HTTP errors (e.g. 409 conflicts thrown by product handlers)
  // must pass through untouched — they carry a `.code` but are NOT wrkf errors.
  if (error instanceof AcpHttpError) {
    return error
  }
  if (isWrkfError(error)) {
    return new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
  }
  return error
}

export async function withPbcRouteIdempotency(
  context: RouteContext,
  routeKey: string,
  run: (body: Record<string, unknown>, idempotencyKey: string) => Promise<unknown>
): Promise<Response> {
  const body = requireRecord(await parseJsonBody(context.request))
  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')
  const bodyHash = hashStableJson(body)
  const storeKey = `${routeKey}:${idempotencyKey}`
  const checked = await context.deps.pbcIdempotencyStore.check(storeKey, bodyHash)

  if (checked.state === 'replay') {
    return json(checked.result, 200)
  }
  if (checked.state === 'conflict') {
    throw new AcpHttpError(
      409,
      'IDEMPOTENCY_MISMATCH',
      'idempotency key was already used with a different request body',
      { idempotencyKey }
    )
  }

  try {
    const result = await run(body, idempotencyKey)
    await context.deps.pbcIdempotencyStore.persist(storeKey, bodyHash, result)
    return json(result, 200)
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}

function hashStableJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function isWrkfError(error: unknown): error is Error & { code: string } {
  const candidate = error as { code?: unknown }
  return error instanceof Error && typeof candidate.code === 'string' && candidate.code.length > 0
}

function readCaptures(wrkf: AcpWrkfWorkflowPort): PbcHarnessPort['captures'] | undefined {
  const candidate = wrkf as AcpWrkfWorkflowPort & { captures?: unknown }
  const captures = candidate.captures
  if (
    typeof captures === 'object' &&
    captures !== null &&
    typeof (captures as { get?: unknown }).get === 'function' &&
    typeof (captures as { set?: unknown }).set === 'function'
  ) {
    return captures as PbcHarnessPort['captures']
  }
  return undefined
}
