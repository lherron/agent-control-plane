/**
 * T-10846: always-on structured request log. One JSON line per HTTP request on
 * stdout (launchd routes it to var/logs/acp-server.log), in the same
 * `{level, component, event, data, ts}` shape the in-process gateway logs use.
 *
 * Never logged: request or response bodies, query strings, headers. For non-2xx
 * JSON responses only the error `code`, `message` and `requestId` are lifted
 * from the body. Streams (ndjson event feeds, WebSockets) log once at open and
 * once at close, never per frame.
 */

type LogLevel = 'info' | 'warn' | 'error'

export interface RequestLogContext {
  method: string
  path: string
  remote: string | undefined
  startedAt: number
  requestId?: string | undefined
}

const MOBILE_SESSIONS_CREATE_PATH = '/v1/mobile/sessions'

// The in-process Discord gateway polls these every few seconds over loopback.
// Successful polls are not logged; a failing poll still is.
const QUIET_POLL_PATHS = [
  /^\/v1\/admin\/system-events$/,
  /^\/v1\/gateway\/[^/]+\/deliveries\/stream$/,
]

function isQuietPoll(context: RequestLogContext): boolean {
  return context.method === 'GET' && QUIET_POLL_PATHS.some((pattern) => pattern.test(context.path))
}

export function startRequestLog(
  request: Request,
  url: URL,
  remote: string | undefined
): RequestLogContext {
  return { method: request.method, path: url.pathname, remote, startedAt: performance.now() }
}

/**
 * Mobile create-session carries its client `requestId` only in the request body.
 * Lift that one field so a phone's attempt can be correlated even on success.
 */
export async function readMobileSessionRequestId(
  request: Request,
  url: URL
): Promise<string | undefined> {
  if (request.method !== 'POST' || url.pathname !== MOBILE_SESSIONS_CREATE_PATH) return undefined
  try {
    const body = (await request.clone().json()) as unknown
    if (typeof body === 'object' && body !== null) {
      const requestId = (body as Record<string, unknown>)['requestId']
      if (typeof requestId === 'string' && requestId.length > 0) return requestId.slice(0, 128)
    }
  } catch {
    // Malformed body: the handler reports it; the log line just lacks a requestId.
  }
  return undefined
}

/**
 * Logs the request and returns the response to send. A streamed ndjson body is
 * wrapped so its close is logged with the stream's full duration.
 */
export function finishRequestLog(context: RequestLogContext, response: Response): Response {
  const base = {
    method: context.method,
    path: context.path,
    status: response.status,
    durationMs: elapsed(context),
    remote: context.remote ?? null,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
  }

  if (response.ok) {
    if (isStream(response)) {
      emit('info', 'http.stream.open', base)
      return wrapStreamClose(context, response)
    }
    if (!isQuietPoll(context)) emit('info', 'http.request', base)
    return response
  }

  if (!isJson(response)) {
    emit(levelFor(response.status), 'http.request', base)
    return response
  }
  void response
    .clone()
    .json()
    .then(
      (body: unknown) =>
        emit(levelFor(response.status), 'http.request', { ...base, ...errorFields(body, context) }),
      () => emit(levelFor(response.status), 'http.request', base)
    )
  return response
}

export function logWebSocketOpen(context: RequestLogContext): void {
  emit('info', 'http.ws.open', {
    method: context.method,
    path: context.path,
    status: 101,
    remote: context.remote ?? null,
  })
}

export function logWebSocketClose(context: RequestLogContext, code: number | undefined): void {
  emit('info', 'http.ws.close', {
    method: context.method,
    path: context.path,
    durationMs: elapsed(context),
    remote: context.remote ?? null,
    ...(code !== undefined ? { closeCode: code } : {}),
  })
}

/** Stack to stderr for every 5xx and every untyped error reaching errorResponse. */
export function logErrorStack(status: number, error: unknown, untyped: boolean): void {
  if (status < 500 && !untyped) return
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) }
  console.error(
    JSON.stringify({
      level: 'error',
      component: 'acp-http',
      event: untyped ? 'http.error.untyped' : 'http.error.5xx',
      data: { status },
      err,
      ts: new Date().toISOString(),
    })
  )
}

function wrapStreamClose(context: RequestLogContext, response: Response): Response {
  const source = response.body
  if (source === null) return response
  const reader = source.getReader()
  let closed = false
  const close = (outcome: 'end' | 'cancel' | 'error') => {
    if (closed) return
    closed = true
    emit('info', 'http.stream.close', {
      method: context.method,
      path: context.path,
      status: response.status,
      durationMs: elapsed(context),
      remote: context.remote ?? null,
      outcome,
    })
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          close('end')
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        close('error')
        controller.error(error)
      }
    },
    async cancel(reason) {
      close('cancel')
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function errorFields(body: unknown, context: RequestLogContext): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const record = body as Record<string, unknown>
  // Two error shapes: ACP's `{error: {code, message, details}}` and the mobile
  // `{ok: false, code, message, requestId}`.
  const nested =
    typeof record['error'] === 'object' && record['error'] !== null
      ? (record['error'] as Record<string, unknown>)
      : undefined
  const source = nested ?? record
  const details =
    nested !== undefined && typeof nested['details'] === 'object' && nested['details'] !== null
      ? (nested['details'] as Record<string, unknown>)
      : undefined
  const fields: Record<string, unknown> = {}
  const code = source['code']
  if (typeof code === 'string') fields['code'] = code
  const message = source['message']
  if (typeof message === 'string') fields['message'] = message.slice(0, 500)
  // An untyped 500 hides the real failure in details.cause.
  const cause = details?.['cause']
  if (typeof cause === 'string') fields['cause'] = cause.slice(0, 500)
  const requestId = record['requestId'] ?? details?.['requestId']
  if (context.requestId === undefined && typeof requestId === 'string') {
    fields['requestId'] = requestId
  }
  return fields
}

function isStream(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get('content-type')?.startsWith('application/x-ndjson') === true
  )
}

function isJson(response: Response): boolean {
  return response.headers.get('content-type')?.includes('json') === true
}

function levelFor(status: number): LogLevel {
  return status >= 500 ? 'error' : 'warn'
}

function elapsed(context: RequestLogContext): number {
  return Math.round(performance.now() - context.startedAt)
}

function emit(level: LogLevel, event: string, data: Record<string, unknown>): void {
  // All request lines go to stdout so acp-server.log is one complete request
  // log; stacks (logErrorStack) are the stderr half.
  console.log(
    JSON.stringify({ level, component: 'acp-http', event, data, ts: new Date().toISOString() })
  )
}
