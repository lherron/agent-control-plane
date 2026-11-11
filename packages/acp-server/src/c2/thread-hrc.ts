/** HRC wire fields observed on max3. The SDK's session DTO omits continuity facts. */
import { HrcDomainError, isTerminalRuntimeStatus } from 'hrc-core'
import type { AcpHrcClient } from '../deps.js'

import type { SessionWork as ThreadWork } from '../hrc-client.js'
export type ThreadSeat = {
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  status: string
  runtimeId?: string | null | undefined
  runtimeStatus?: string | null | undefined
  lastActivityAt?: string
  disposition?: string | null | undefined
  work?: ThreadWork
  workEtag?: number
  continuation?: unknown
}

export async function threadSeats(
  client: AcpHrcClient,
  scopeRef?: string,
  withWork = false
): Promise<ThreadSeat[]> {
  const [sessions, runtimes] = await Promise.all([
    client.listSessions({ all: true, latestGeneration: true, ...(scopeRef ? { scopeRef } : {}) }),
    client.listRuntimes({ omitState: true, ...(scopeRef ? { scope: scopeRef } : {}) }),
  ])
  const eligible = new Set<string>()
  if (withWork && !scopeRef && client.listSessionsPage) {
    let cursor: string | undefined
    do {
      const page = await client.listSessionsPage({
        nodes: 'local',
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })
      for (const row of page.items)
        if (row.disposition === 'parked' || row.effectiveStatus === 'active')
          eligible.add(row.scopeRef)
      cursor = page.nextCursor
    } while (cursor)
  }
  const seats: ThreadSeat[] = []
  for (const session of sessions) {
    if (session.laneRef !== 'main' || (scopeRef && session.scopeRef !== scopeRef)) continue
    const runtime = runtimes.find(
      (r) => r.hostSessionId === session.hostSessionId && !isTerminalRuntimeStatus(r.status)
    )
    const seat: ThreadSeat = {
      ...session,
      runtimeId: runtime?.runtimeId,
      runtimeStatus: runtime?.status,
      ...(runtime?.lastActivityAt ? { lastActivityAt: runtime.lastActivityAt } : {}),
    }
    if (withWork && client.getSessionByContinuity && client.getSessionWork) {
      if (!scopeRef && !runtime && !eligible.has(session.scopeRef)) continue
      let record: Awaited<ReturnType<NonNullable<AcpHrcClient['getSessionByContinuity']>>>
      try {
        record = await client.getSessionByContinuity({
          scopeRef: session.scopeRef,
          laneRef: 'main',
        })
      } catch (error) {
        if (!scopeRef && error instanceof HrcDomainError) continue
        throw error
      }
      seat.disposition = record.disposition
      if (runtime || record.disposition === 'parked') {
        const work = await client.getSessionWork(session.scopeRef)
        seat.work = work.work
        seat.workEtag = work.workEtag
        seats.push(seat)
      }
    } else seats.push(seat)
  }
  return seats
}

export async function startThreadSeat(
  client: AcpHrcClient,
  scopeRef: string,
  requestId: string
): Promise<void> {
  const { intent } = await client.resolveRuntimeIntent({
    scopeRef,
    runMode: 'task',
    interactive: true,
    preferredMode: 'headless',
  })
  await client.startRuntime({
    sessionRef: `${scopeRef}/lane:main`,
    runtimeIntent: intent,
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: requestId,
    restartStyle: 'reuse_pty',
  })
}

export async function archiveThreadSeat(
  client: AcpHrcClient,
  seat: ThreadSeat,
  reason: string
): Promise<void> {
  if (seat.status !== 'active' || !seat.runtimeId || !seat.runtimeStatus) return
  await client.terminate(seat.runtimeId, {
    dropContinuation: false,
    actor: 'agent:lance',
    source: 'c2-threads',
    reason,
  })
}

export async function writeThreadWork(
  client: AcpHrcClient,
  scopeRef: string,
  work: ThreadWork,
  ifMatch?: number
): Promise<void> {
  if (!client.getSessionWork || !client.putSessionWork) throw new Error('seat_work_unavailable')
  const current = await client.getSessionWork(scopeRef)
  if (JSON.stringify(current.work) === JSON.stringify(work)) return
  await client.putSessionWork(
    { scopeRef, work, ifMatch: ifMatch ?? current.workEtag },
    'agent:lance'
  )
}
