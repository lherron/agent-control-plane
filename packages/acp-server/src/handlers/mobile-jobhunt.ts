import { writeLogLine } from 'acp-core'

import { AcpHttpError } from '../http.js'
import { loopbackUpstreamRefusal, upstreamHop } from '../loopback-upstream.js'
import { isRecord } from '../parsers/body.js'
import type { RouteContext, RouteHandler } from '../routing/route-context.js'

const UPSTREAM_PATHS = {
  triage: '/api/hunt/mobile/triage',
  lead: '/api/hunt/mobile/leads/',
  decision: '/api/hunt/mobile/leads/',
  ask: '/api/hunt/leads/',
} as const
const MAX_BODY_BYTES = 64 * 1024
const LEAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const NO_STORE = { 'cache-control': 'no-store' }

type Route = keyof typeof UPSTREAM_PATHS
export type JobhuntOptions = {
  baseUrl?: string | undefined
  /** Dependency injection for tests; production deadlines are not environment knobs. */
  getDeadlineMs?: number | undefined
  postDeadlineMs?: number | undefined
}
export type JobhuntConfig = {
  baseUrl: URL | undefined
  disabledReason: string | undefined
  getDeadlineMs: number
  postDeadlineMs: number
}

export function resolveJobhuntConfig(options: JobhuntOptions = {}): JobhuntConfig {
  let baseUrl: URL | undefined
  let disabledReason: string | undefined
  try {
    baseUrl = new URL(options.baseUrl ?? process.env['ACP_JOBHUNT_URL'] ?? 'http://127.0.0.1:18455')
    if (loopbackUpstreamRefusal(baseUrl) !== undefined) {
      disabledReason = 'Jobhunt upstream must name a loopback HTTP host without credentials'
      baseUrl = undefined
    }
  } catch {
    disabledReason = 'Invalid Jobhunt upstream URL'
  }
  if (disabledReason !== undefined) {
    writeLogLine({
      level: 'warn',
      component: 'mobile-jobhunt',
      event: 'jobhunt.disabled',
      data: { reason: disabledReason },
    })
  }
  return {
    baseUrl,
    disabledReason,
    getDeadlineMs: options.getDeadlineMs ?? 10_000,
    postDeadlineMs: options.postDeadlineMs ?? 30_000,
  }
}

async function postBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader !== undefined) {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {})
          throw new AcpHttpError(413, 'invalid_request', 'POST body exceeds 64 KiB')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const body = Buffer.concat(chunks)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new AcpHttpError(400, 'invalid_request', 'POST body must be a JSON object')
  }
  if (!isRecord(parsed)) {
    throw new AcpHttpError(400, 'invalid_request', 'POST body must be a JSON object')
  }
  return body
}

function handler(route: Route): RouteHandler {
  return async (context: RouteContext) => {
    const started = performance.now()
    const post = context.request.method === 'POST'
    let outcome: number | string = 'invalid_request'
    const fail = (
      status: number,
      code: string,
      message: string,
      details: Record<string, unknown> = {}
    ) => {
      outcome = code
      return Response.json({ error: { code, message, details } }, { status, headers: NO_STORE })
    }
    try {
      const id = context.params['id']
      if (route !== 'triage' && (id === undefined || !LEAD_ID.test(id))) {
        return fail(400, 'invalid_request', 'Invalid lead id')
      }
      const body = post ? await postBody(context.request) : undefined
      const config = context.deps.jobhuntConfig
      if (config.baseUrl === undefined) {
        return fail(
          503,
          'gateway_jobhunt_unavailable',
          'Jobhunt is unavailable',
          post ? { submitted: false } : {}
        )
      }
      const path =
        UPSTREAM_PATHS[route] +
        (route === 'triage' ? '' : `${id}${route === 'lead' ? '' : `/${route}`}`) +
        context.url.search
      let upstream: { status: number; body: Buffer }
      try {
        upstream = await upstreamHop({
          base: config.baseUrl,
          path,
          method: context.request.method,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          deadlineMs: post ? config.postDeadlineMs : config.getDeadlineMs,
        })
      } catch (error) {
        // ECONNREFUSED means no connection was established, hence no bytes sent.
        // Every other transport failure is conservative about a possibly applied write.
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          return fail(
            503,
            'gateway_jobhunt_unavailable',
            'Jobhunt is unavailable',
            post ? { submitted: false } : {}
          )
        }
        return fail(
          504,
          post ? 'gateway_jobhunt_uncertain' : 'gateway_jobhunt_timeout',
          'Jobhunt did not complete its response',
          post ? { submitted: 'unknown' } : {}
        )
      }
      try {
        JSON.parse(upstream.body.toString('utf8'))
      } catch {
        return fail(
          502,
          post ? 'gateway_jobhunt_uncertain' : 'gateway_jobhunt_bad_response',
          'Jobhunt returned a non-JSON response',
          post ? { submitted: 'unknown', status: upstream.status } : {}
        )
      }
      outcome = upstream.status
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...NO_STORE, 'content-type': 'application/json' },
      })
    } catch (error) {
      if (error instanceof AcpHttpError) return fail(error.status, error.code, error.message)
      throw error
    } finally {
      writeLogLine({
        level: 'info',
        component: 'mobile-jobhunt',
        event: 'jobhunt.forward',
        data: { route, outcome, durationMs: performance.now() - started },
      })
    }
  }
}

export const handleJobhuntTriage = handler('triage')
export const handleJobhuntLead = handler('lead')
export const handleJobhuntDecision = handler('decision')
export const handleJobhuntAsk = handler('ask')
