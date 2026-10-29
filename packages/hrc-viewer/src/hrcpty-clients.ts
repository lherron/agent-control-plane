/**
 * Who is ALREADY attached to an hrcpty seat (T-12046) — the hrcpty twin of
 * `tmux-clients.ts`, consulted at the same seam and under the same contract.
 *
 * An hrcpty seat has no tmux server to `list-clients`; its supervisor counts
 * its own attach clients and answers `status` on the ops socket
 * (`clients: {total, readWrite, readOnly}`). The ops socket is JSON-RPC over
 * NDJSON gated by the `attach.token` rusthrc writes beside it, so the probe
 * says `hello` with that token first.
 *
 * Fails OPEN by contract, as the tmux probe does: an unreadable token, a
 * missing socket, a refused hello, a timeout or an unparsable answer all count
 * as 0 attached clients, and the viewer creates as before.
 */
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'

/** Bounded so a wedged supervisor cannot stall the create path. */
export const DEFAULT_HRCPTY_CLIENT_PROBE_TIMEOUT_MS = 2_000

/** Attached client count for one hrcpty seat, or 0 for every negative and indeterminate answer. */
export type HrcptyClientProbe = (socketPath: string) => Promise<number>

/** rusthrc writes the ops-socket token beside the socket (`<ipcDir>/attach.token`). */
export function hrcptyTokenPath(socketPath: string): string {
  return join(dirname(socketPath), 'attach.token')
}

/** `clients.total` out of a `status` result; anything else is 0. */
export function parseHrcptyClientCount(status: unknown): number {
  if (status === null || typeof status !== 'object') return 0
  const clients = (status as Record<string, unknown>)['clients']
  if (clients === null || typeof clients !== 'object') return 0
  const total = (clients as Record<string, unknown>)['total']
  return typeof total === 'number' && Number.isInteger(total) && total > 0 ? total : 0
}

/** One `hello` then one `status` on a fresh ops connection; rejects on any failure. */
async function readStatus(socketPath: string, token: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => finish(new Error('hrc-pty status timed out')), timeoutMs)
    let buffered = ''
    let settled = false
    const finish = (error: Error | undefined, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error === undefined) resolve(result)
      else reject(error)
    }
    const send = (id: number, method: string, params: Record<string, unknown>) =>
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

    socket.on('connect', () => send(1, 'hello', { token }))
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('hrc-pty closed the ops connection')))
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line) as Record<string, unknown>
        } catch {
          finish(new Error('hrc-pty answered a frame that is not JSON'))
          return
        }
        if (frame['error'] !== undefined) {
          finish(new Error(`hrc-pty refused: ${JSON.stringify(frame['error'])}`))
          return
        }
        if (frame['id'] === 1) send(2, 'status', {})
        else if (frame['id'] === 2) finish(undefined, frame['result'])
      }
    })
  })
}

export function createHrcptyClientProbe(
  options: { timeoutMs?: number | undefined } = {}
): HrcptyClientProbe {
  const timeoutMs = Math.max(
    1,
    Math.trunc(options.timeoutMs ?? DEFAULT_HRCPTY_CLIENT_PROBE_TIMEOUT_MS)
  )

  return async (socketPath) => {
    try {
      const token = (await readFile(hrcptyTokenPath(socketPath), 'utf8')).trim()
      if (token === '') return 0
      return parseHrcptyClientCount(await readStatus(socketPath, token, timeoutMs))
    } catch {
      return 0
    }
  }
}
