import { useQuery } from '@tanstack/react-query'
import type {
  DashboardEvent,
  SessionDashboardSnapshot,
  SessionTimelineRow,
} from 'acp-ops-projection'

export type SnapshotRequest = {
  fromSeq?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
}

export async function fetchSessionDashboardSnapshot(
  request: SnapshotRequest = {}
): Promise<SessionDashboardSnapshot> {
  const params = new URLSearchParams()

  if (request.fromSeq !== undefined) params.set('fromSeq', String(request.fromSeq))
  if (request.scopeRef !== undefined) params.set('scopeRef', request.scopeRef)
  if (request.laneRef !== undefined) params.set('laneRef', request.laneRef)
  if (request.hostSessionId !== undefined) params.set('hostSessionId', request.hostSessionId)

  const query = params.toString()
  const url = `/v1/ops/session-dashboard/snapshot${query ? `?${query}` : ''}`

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Snapshot fetch failed: ${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<SessionDashboardSnapshot>
}

export function sessionDashboardSnapshotQueryOptions(request: SnapshotRequest = {}) {
  return {
    queryKey: ['session-dashboard-snapshot', request],
    queryFn: () => fetchSessionDashboardSnapshot(request),
    retry: false,
  } as const
}

export function useSessionDashboardSnapshot(request: SnapshotRequest = {}) {
  return useQuery(sessionDashboardSnapshotQueryOptions(request))
}

export function createEmptyDashboardSnapshot(
  now = new Date(0).toISOString()
): SessionDashboardSnapshot {
  return {
    serverTime: now,
    generatedAt: now,
    window: {
      fromTs: now,
      toTs: now,
      fromHrcSeq: 0,
      toHrcSeq: 0,
    },
    cursors: {
      nextFromSeq: 0,
      lastHrcSeq: 0,
      lastStreamSeq: 0,
    },
    summary: {
      counts: {
        busy: 0,
        idle: 0,
        launching: 0,
        stale: 0,
        dead: 0,
        inFlightInputs: 0,
        deliveryPending: 0,
      },
      eventRatePerMinute: 0,
      streamLagMs: 0,
      droppedEvents: 0,
      reconnectCount: 0,
    },
    sessions: [],
    events: [],
  }
}

export function createDevelopmentDashboardSnapshot(): SessionDashboardSnapshot {
  const serverTime = '2026-04-23T19:32:18.900Z'
  const sessions = [
    demoSession(1, 'editorial_director', 'content_ai_ops', 'implementer', 'busy', 7, 17, true),
    demoSession(2, 'principal_publisher', 'content_ai_ops', 'owner', 'busy', 12, 18, false),
    demoSession(3, 'trainer', 'fitness', 'main', 'busy', 9, 9, false),
    demoSession(4, 'researcher', 'intel', 'analyst', 'launching', 2, 11, false),
    demoSession(5, 'support', 'customer_success', 'triage', 'idle', 4, 5, false),
    demoSession(6, 'writer', 'content_factory', 'draft', 'stale', 1, 7, false),
  ]
  const events = sessions.slice(0, 3).flatMap((session, index) => demoEvents(session, index))

  return {
    serverTime,
    generatedAt: serverTime,
    window: {
      fromTs: '2026-04-23T19:31:00.000Z',
      toTs: serverTime,
      fromHrcSeq: 34,
      toHrcSeq: 44,
    },
    cursors: {
      nextFromSeq: 45,
      lastHrcSeq: 44,
      lastStreamSeq: 144,
    },
    summary: {
      counts: {
        busy: 7,
        idle: 12,
        launching: 2,
        stale: 1,
        dead: 0,
        inFlightInputs: 4,
        deliveryPending: 3,
      },
      eventRatePerMinute: 1842,
      streamLagMs: 38,
      droppedEvents: 0,
      reconnectCount: 0,
    },
    sessions,
    events,
  }
}

function demoSession(
  index: number,
  agent: string,
  project: string,
  lane: string,
  status: string,
  eventCount: number,
  generation: number,
  supportsInFlightInput: boolean
): SessionTimelineRow {
  const inputAttemptId = supportsInFlightInput ? `in_981${index}` : undefined

  return {
    rowId: `hs_7f2${index}:${generation}`,
    sessionRef: {
      scopeRef: `agent:${agent}:project:${project}:role:${lane}`,
      laneRef: lane === 'implementer' || lane === 'owner' ? 'main' : lane,
    },
    hostSessionId: `hs_7f2${index}`,
    generation,
    runtime: {
      runtimeId: `rt_44${index}`,
      launchId: `launch_${index}`,
      transport: 'sdk',
      harness: 'acp_harness_v3.2.1',
      provider: 'openai-gpt-4.1',
      status,
      supportsInFlightInput,
      activeRunId: `r_814${index}`,
      lastActivityAt: '2026-04-23T19:32:18.700Z',
    },
    acp: {
      latestRunId: `r_814${index}`,
      taskId: `ops_${index}`,
      workflowPreset: 'live-ops',
      deliveryPending: index < 3,
      ...(inputAttemptId ? { inputAttemptId } : {}),
    },
    visualState: {
      priority: index,
      colorRole:
        status === 'stale'
          ? 'warning'
          : status === 'launching'
            ? 'tool'
            : supportsInFlightInput
              ? 'input'
              : 'runtime',
      continuity: status === 'stale' ? 'broken' : supportsInFlightInput ? 'blocked' : 'healthy',
    },
    stats: {
      eventsInWindow: eventCount,
      eventsPerMinute: eventCount * 90,
      lastEventAt: `2026-04-23T19:32:${String(18 - index * 2).padStart(2, '0')}.700Z`,
    },
  }
}

function demoEvents(row: SessionTimelineRow, rowIndex: number): DashboardEvent[] {
  const baseSeq = 36 + rowIndex * 20
  const baseSecond = 3 + rowIndex * 2
  const kinds: Array<[DashboardEvent['family'], string, DashboardEvent['severity'], string]> = [
    ['runtime', 'resolveSession', 'info', 'resolveSession'],
    ['runtime', 'inputAttempt', 'success', 'InputAttempt'],
    ['agent_message', 'message_start', 'info', 'message_start'],
    ['agent_message', 'message_update', 'info', 'message_update'],
    ['tool', 'tool_execution_start', 'info', 'tool_execution_start'],
    ['tool', 'tool_execution_end', 'success', 'tool_execution_end'],
    ['input', 'user_input_queued_in_flight', 'info', 'user_input_queued_in_flight'],
    ['input', 'user_input_applied_in_flight', 'success', 'user_input_applied_in_flight'],
    ['delivery', 'delivery.pending', 'info', 'delivery.pending'],
    rowIndex === 1
      ? ['handoff', 'handoff.complete', 'success', 'handoff.complete']
      : ['runtime', 'turn.accepted', 'success', 'turn.accepted'],
  ]

  return kinds.map(([family, eventKind, severity, label], index) => {
    const runtimeId = row.runtime?.runtimeId
    const runId = row.runtime?.activeRunId

    return {
      id: `${row.hostSessionId}:${baseSeq + index}`,
      hrcSeq: baseSeq + index,
      streamSeq: 100 + baseSeq + index,
      ts: `2026-04-23T19:32:${String(baseSecond + index * 4).padStart(2, '0')}.700Z`,
      sessionRef: row.sessionRef,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      ...(runtimeId ? { runtimeId } : {}),
      ...(runId ? { runId } : {}),
      eventKind,
      category: family === 'input' ? 'inflight' : family,
      family,
      severity,
      label,
      payloadPreview: {
        inputAttemptId: row.acp?.inputAttemptId,
        shortDetail: `${label} for ${row.hostSessionId}`,
      },
      redacted: false,
    }
  })
}
