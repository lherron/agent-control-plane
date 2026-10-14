import type { KickerLogLevel } from './policy/contracts.js'

type LogFn = (level: KickerLogLevel, event: string, detail: Record<string, unknown>) => void

/**
 * Daemon log lines in the Praesidium standard shape (logging.md L2): one JSON
 * object per line with `ts`, `level`, `component`, `event` and `data`. The
 * kicker's event names pass through unchanged.
 */
export function createJsonLineLog(
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk)
): LogFn {
  return (level, event, detail) => {
    const data = toJsonSafe(detail, []) as Record<string, unknown>
    write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: level.toLowerCase(),
        component: 'hrc-mail-injector',
        event,
        ...(Object.keys(data).length > 0 ? { data } : {}),
      })}\n`
    )
  }
}

function toJsonSafe(value: unknown, ancestors: object[]): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (ancestors.includes(value)) return '[Circular]'
  const path = [...ancestors, value]
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, path))
  if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), path)
  if (value instanceof Set) return toJsonSafe([...value], path)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonSafe(item, path)])
  )
}
