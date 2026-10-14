/**
 * The Praesidium log line (logging.md L2): one JSON object per line with
 * `level`, `component`, `event`, optional `data`, and `ts`. Every ACP daemon
 * writer goes through here so the request log, startup lines and subsystem
 * warnings share one shape.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogLineInput = {
  level: LogLevel
  component: string
  event: string
  data?: Record<string, unknown> | undefined
  /** An error or error-like value; serialized as {name, message, stack}. */
  err?: unknown
}

/**
 * debug/info go to stdout (console.log) and warn/error to stderr
 * (console.warn/console.error) unless `stream` is named; the request log keeps
 * every `http.request` line on stdout.
 */
export function writeLogLine(input: LogLineInput, stream?: 'stdout' | 'stderr'): void {
  const line = JSON.stringify({
    level: input.level,
    component: input.component,
    event: input.event,
    ...(input.data !== undefined && Object.keys(input.data).length > 0 ? { data: input.data } : {}),
    ...(input.err !== undefined ? { err: errorFields(input.err) } : {}),
    ts: new Date().toISOString(),
  })
  const target = stream ?? (input.level === 'warn' || input.level === 'error' ? 'stderr' : 'stdout')
  if (target === 'stdout') console.log(line)
  else if (input.level === 'warn') console.warn(line)
  else console.error(line)
}

export function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { message: String(error) }
}
