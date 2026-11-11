/** Bounded owner reads per sweep; only a record's own W seat can be archived. */
import { writeLogLine } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { archiveThreadSeat, threadSeats } from './thread-hrc.js'
import { allThreads, createThreads, reason, seatRecord } from './threads.js'

export function startThreadSweep(deps: ResolvedAcpServerDeps): () => void {
  const config = deps.c2
  if (!config || !deps.hrcClient || !deps.workClientForPrincipal) return () => {}
  const hrc = deps.hrcClient
  let running = false
  const log = (event: string, data: Record<string, unknown>) =>
    writeLogLine({ level: 'info', component: 'acp-c2', event, data })
  async function sweep() {
    if (running) return
    running = true
    try {
      const client = await createThreads(deps).client()
      const threads = (await allThreads(client)).filter(
        (t) =>
          !['completed', 'cancelled', 'archived', 'deleted'].includes(t.state) ||
          (t.state === 'completed' &&
            Date.parse(t.completedAt ?? t.updatedAt) > Date.now() - 86_400_000)
      )
      const seats = await threadSeats(hrc)
      for (const thread of threads) {
        try {
          const scope = await seatRecord(client, thread.id)
          if (!scope) continue
          const seat = seats.find((s) => s.scopeRef === scope)
          if (!seat || seat.status !== 'active' || !seat.runtimeId || !seat.runtimeStatus) continue
          if (thread.state !== 'completed') {
            if (seat.runtimeStatus === 'busy' || seat.runtimeStatus === 'starting') continue
            const attention = await hrc.getSessionAttention({ scopeRef: scope, laneRef: 'main' })
            if (attention.attention) continue
            const age = Date.now() - Date.parse(seat.lastActivityAt ?? '')
            if (!Number.isFinite(age) || age <= (config?.threadIdleMs ?? 14_400_000)) continue
          }
          await archiveThreadSeat(
            hrc,
            seat,
            `c2 thread ${thread.id}: ${thread.state === 'completed' ? 'closed' : 'idle'}`
          )
          log('c2.thread.archived', { threadId: thread.id, scopeRef: scope })
        } catch (error) {
          log('c2.thread.archive_failed', { threadId: thread.id, reason: reason(error) })
        }
      }
    } catch (error) {
      log('c2.thread.sweep_failed', { reason: reason(error) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void sweep(), config.threadSweepMs ?? 600_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
