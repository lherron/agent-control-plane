/**
 * `/v1/mobile/c2/v2/*` (card contract rev 4.1 §12 "Mobile wire"), behind the existing
 * mobile gate (`classifyMobileRoute` puts every `/v1/mobile/...` path in the
 * bearer tier; nothing here adds or relaxes auth). No client `scope`, home URL
 * or Vesta identity is accepted.
 */
import type { RouteHandler } from '../routing/route-context.js'
import { LONG_POLL_MAX_MS, ensureC2Service } from './controller-host.js'

/** §12.1: every v1 card route answers 410 and executes nothing, so an old phone fails closed. */
export const handleC2V1Gone: RouteHandler = async () =>
  Response.json({ ok: false, code: 'wire_version_unsupported', wire: 2 }, { status: 410 })

function unavailable(): Response {
  return Response.json({ ok: false, code: 'home_unavailable' }, { status: 503 })
}

function badRequest(reason: string): Response {
  return Response.json({ ok: false, code: 'invalid_request', reason }, { status: 400 })
}

function parseInteger(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined
  return Number.parseInt(raw, 10)
}

export const handleC2Snapshot: RouteHandler = async ({ url, deps }) => {
  const service = ensureC2Service(deps)
  if (service === undefined) return unavailable()
  const after = url.searchParams.get('after') ?? undefined
  const rawWait = url.searchParams.get('waitMs')
  let waitMs: number | undefined
  if (rawWait !== null) {
    waitMs = parseInteger(rawWait)
    if (waitMs === undefined || waitMs > LONG_POLL_MAX_MS) {
      return badRequest(`waitMs must be an integer 0..${LONG_POLL_MAX_MS}`)
    }
  }
  const result = await service.snapshot({ after, waitMs })
  return Response.json(result.body, { status: result.status })
}

export const handleC2Action: RouteHandler = async ({ request, deps }) => {
  const service = ensureC2Service(deps)
  if (service === undefined) return unavailable()
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('body must be JSON')
  }
  const result = await service.act(raw)
  return Response.json(result.body, { status: result.status })
}

export const handleC2Reconcile: RouteHandler = async ({ url, params, deps }) => {
  const service = ensureC2Service(deps)
  if (service === undefined) return unavailable()
  const requestId = params['requestId']
  const sessionRef = url.searchParams.get('sessionRef')
  if (requestId === undefined || requestId === '') return badRequest('requestId is required')
  if (sessionRef === null || sessionRef === '') return badRequest('sessionRef is required')
  const result = await service.reconcile(requestId, sessionRef)
  return Response.json(result.body, { status: result.status })
}

export const handleC2Artifact: RouteHandler = async ({ params, deps }) => {
  const service = ensureC2Service(deps)
  if (service === undefined) return unavailable()
  return service.artifact(params['id'] ?? '')
}
