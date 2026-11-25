import { writeLogLine } from 'acp-core'

import { UpstreamDeadlineError, upstreamStream } from '../loopback-upstream.js'
import { discardRequestBody, getMobileApi } from '../mobile-apis.js'
import type { RouteHandler } from '../routing/route-context.js'
import { assetPath, relayError } from './mobile-plugins.js'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const DEADLINE_MS = 30_000
const REQUEST_HEADERS = ['content-type', 'accept', 'if-none-match', 'idempotency-key']
const RANGE_HEADERS = ['range', 'if-range']
const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
]

/** Null means the limit was crossed, undefined means there was no body. */
async function readRelayBody(
  request: Request,
  onDiscard?: () => void
): Promise<Buffer | null | undefined> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null
  const reader = request.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0
        await discardRequestBody(reader, onDiscard)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

export const handleMobileApi: RouteHandler = async (context) => {
  const { request, url, params, mobileDeviceId } = context
  const apiId = params['apiId'] ?? ''
  const api = getMobileApi(apiId)
  if (api === undefined) return relayError(404, 'unknown_api', 'No such mobile API')
  const path = assetPath(api.prefix, params['path'] ?? '')
  if (path === undefined)
    return relayError(400, 'invalid_path', 'Path must stay under the mobile API prefix')
  if (mobileDeviceId === undefined) throw new Error('Mobile API route bypassed the mobile gate')

  const body = await readRelayBody(request, context.onDiscardRequestBody)
  if (body === null) return relayError(413, 'body_too_large', 'Request body exceeds 4 MiB')

  const method = request.method
  const read = method === 'GET' || method === 'HEAD'
  const headers: Record<string, string> = { 'X-Praesidium-Mobile-Device': mobileDeviceId }
  for (const name of read ? [...REQUEST_HEADERS, ...RANGE_HEADERS] : REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers[name] = value
  }
  // Set the framing from the buffered bytes, never from the phone's headers.
  if (body !== undefined) headers['content-length'] = String(body.length)

  const started = performance.now()
  let status = 503
  try {
    const upstream = await upstreamStream({
      base: api.origin,
      path: path + url.search,
      method,
      headers,
      body,
      deadlineMs: DEADLINE_MS,
      bodyIdleMs: DEADLINE_MS,
      abortResponseStream: context.abortResponseStream,
    })
    const out = new Headers()
    // Bun supplies chunked framing for open streams in place of Content-Length.
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers[name]
      if (typeof value === 'string') out.set(name, value)
    }
    const empty = method === 'HEAD' || [204, 205, 304].includes(upstream.status)
    if (empty) await upstream.body.cancel()
    const response = new Response(empty ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    })
    status = response.status
    return response
  } catch (error) {
    if (error instanceof UpstreamDeadlineError) {
      status = 504
      return relayError(
        status,
        'timeout',
        'Mobile API response head deadline exceeded',
        read ? undefined : { outcome: 'unknown' }
      )
    }
    return relayError(status, 'upstream_unavailable', 'The mobile API did not answer')
  } finally {
    writeLogLine({
      level: 'info',
      component: 'mobile-apis',
      event: 'mobile.api.call',
      data: {
        apiId,
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - started),
        deviceId: mobileDeviceId,
      },
    })
  }
}
