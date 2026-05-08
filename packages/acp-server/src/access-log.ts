import { type WriteStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AccessLogger {
  log(input: AccessLogEntry): void
  close(): void
}

export interface AccessLogEntry {
  request: Request
  response: Response
  durationMs: number
  clientIp: string | undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export async function createAccessLogger(path: string | undefined): Promise<AccessLogger | null> {
  if (path === undefined || path.length === 0) {
    return null
  }
  await mkdir(dirname(path), { recursive: true })
  let stream: WriteStream | null = createWriteStream(path, { flags: 'a' })
  stream.on('error', () => {
    stream = null
  })
  return {
    log(entry: AccessLogEntry): void {
      if (stream === null) {
        return
      }
      try {
        stream.write(`${formatLine(entry)}\n`)
      } catch {
        // best-effort; never throw from the request hot path
      }
    },
    close(): void {
      stream?.end()
      stream = null
    },
  }
}

function formatLine({ request, response, durationMs, clientIp }: AccessLogEntry): string {
  const url = new URL(request.url)
  const path = `${url.pathname}${url.search}`
  const reqLine = `${request.method} ${path} HTTP/1.1`
  const status = response.status
  const size = response.headers.get('content-length') ?? '-'
  const referer = request.headers.get('referer')
  const userAgent = request.headers.get('user-agent')
  const actor = request.headers.get('x-actor') ?? '-'
  const requestId = request.headers.get('x-request-id')
  const ip = clientIp ?? '-'

  let line = `${ip} - ${actor} ${apacheTime(new Date())} ${quote(reqLine)} ${status} ${size} ${quote(referer)} ${quote(userAgent)} ${durationMs}ms`
  if (requestId !== null && requestId.length > 0) {
    line += ` req=${requestId}`
  }
  return line
}

function apacheTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const tz = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  return `[${pad(date.getDate())}/${MONTHS[date.getMonth()]}/${date.getFullYear()}:${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${tz}]`
}

function quote(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return '"-"'
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
