import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Launch =
  | { status: 'started'; runtimeId: string }
  | { status: 'failed'; code?: string; message: string }

type FirstTurn =
  | { delivered: true; runId: string; submissionId: string }
  | { delivered: false; reason: string }

type ActiveSession = { hostSessionId: string; generation: number; sessionRef: string }

export type SeatRestartResult =
  | (ActiveSession & {
      outcome: 'restarted' | 'created' | 'launched'
      priorHostSessionId?: string
      launch: Launch
      scopeRef: string
      replayed?: boolean
      firstTurn?: FirstTurn
      summonDirectives?: { model?: string; reasoning_effort?: string }
    })
  | { outcome: 'unknown'; active?: ActiveSession | null }
  | { outcome: 'armed' }
  | { outcome: 'pending' }

export type SeatRestartCall = (
  op: 'seat-restart.cold' | 'seat-restart.force',
  args: Record<string, unknown>
) => Promise<SeatRestartResult>

export class SeatRestartRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

class SeatRestartUnanswered extends Error {}

type KernelReply =
  | { ok: true; result: SeatRestartResult }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

export const callSeatRestart: SeatRestartCall = (op, args) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(
      process.env['PRAESIDIUM_KERNEL_SOCKET'] ??
        join(homedir(), 'praesidium/var/run/praesidium/kernel.sock')
    )
    const timeout = setTimeout(() => {
      reject(new SeatRestartUnanswered('kernel seat restart timed out'))
      socket.destroy()
    }, 40_000)
    let sent = false
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      sent = true
      const request = {
        id: 1,
        op,
        args: { ...args, caller: { principalRef: 'agent:lance', via: 'acp' } },
      }
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as KernelReply
        if (reply.ok) {
          resolve(reply.result)
        } else {
          const { code, message, details } = reply.error
          reject(new SeatRestartRefusal(code, message, details))
        }
      } catch {
        reject(new SeatRestartUnanswered('invalid kernel seat restart reply'))
      } finally {
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      reject(sent ? new SeatRestartUnanswered(error.message) : new Error(error.message))
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      reject(new SeatRestartUnanswered('kernel connection closed before answering'))
    })
  })

export async function requestSeatRestart(
  call: SeatRestartCall,
  operation: Parameters<SeatRestartCall>[0],
  args: Record<string, unknown>,
  reconcile: Record<string, unknown>
): Promise<SeatRestartResult> {
  try {
    const result = await call(operation, args)
    if (result.outcome !== 'pending') return result
  } catch (error) {
    if (
      !(error instanceof SeatRestartUnanswered) &&
      !(
        error instanceof SeatRestartRefusal &&
        (error.code === 'call_timeout' || error.detail['effect'] === 'unknown')
      )
    )
      throw error
  }

  try {
    const result = await call(operation, reconcile)
    return result.outcome === 'pending' ? { outcome: 'unknown' } : result
  } catch (error) {
    // Only an owner decision can settle a write that may already have committed.
    if (
      error instanceof SeatRestartRefusal &&
      error.code !== 'call_timeout' &&
      error.detail['effect'] === undefined
    )
      throw error
    return { outcome: 'unknown' }
  }
}
