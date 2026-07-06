import type { RunStore, StoredRun } from '../domain/run-store.js'
import {
  type RecentlyCompletedHrcRunEvidence,
  hasRecentlyCompletedHrcRunSince as defaultHasRecentlyCompletedHrcRunSince,
  launchCorrelationUntilIso,
} from '../real-launcher.js'

const DISPATCH_TIMEOUT_TERMINAL_GRACE_KEY = 'dispatchTimeoutTerminalCorrelationGrace'

export type TerminalCorrelationGraceConfig = {
  intervalMs: number
  terminalCorrelationGraceMs?: number | undefined
}

type TerminalCorrelationGraceMarker = {
  hrcRunId: string
  acceptedAt: string
  completedAt: string
  observedAt: string
  expiresAt: string
}

export function terminalCorrelationGraceMs(config: TerminalCorrelationGraceConfig): number {
  return config.terminalCorrelationGraceMs ?? Math.max(config.intervalMs * 2, 5_000)
}

function terminalCorrelationGraceExpiresAt(
  evidence: RecentlyCompletedHrcRunEvidence,
  config: TerminalCorrelationGraceConfig
): string | undefined {
  const completedMs = Date.parse(evidence.completedAt)
  if (Number.isNaN(completedMs)) {
    return undefined
  }
  return new Date(completedMs + terminalCorrelationGraceMs(config)).toISOString()
}

export function hasActiveTerminalCorrelationGrace(run: StoredRun, nowMs = Date.now()): boolean {
  const marker = readTerminalCorrelationGraceMarker(run)
  return marker !== undefined && Date.parse(marker.expiresAt) > nowMs
}

export function hasExpiredTerminalCorrelationGrace(run: StoredRun, nowMs = Date.now()): boolean {
  const marker = readTerminalCorrelationGraceMarker(run)
  if (marker === undefined) {
    return false
  }
  const expiresMs = Date.parse(marker.expiresAt)
  return Number.isNaN(expiresMs) || expiresMs <= nowMs
}

export function protectWithTerminalCorrelationGrace(input: {
  run: StoredRun
  runStore?: RunStore | undefined
  hrcDbPath?: string | undefined
  config: TerminalCorrelationGraceConfig
  nowMs?: number | undefined
  hasRecentlyCompletedHrcRunSince?:
    | ((
        hrcDbPath: string,
        hostSessionId: string,
        since: string,
        until?: string | undefined
      ) => RecentlyCompletedHrcRunEvidence | undefined)
    | undefined
}): boolean {
  const { run } = input
  if (
    run.status !== 'pending' ||
    run.hostSessionId === undefined ||
    run.hrcRunId !== undefined ||
    run.runtimeId !== undefined
  ) {
    return false
  }

  const nowMs = input.nowMs ?? Date.now()
  if (hasActiveTerminalCorrelationGrace(run, nowMs)) {
    return true
  }
  if (hasExpiredTerminalCorrelationGrace(run, nowMs)) {
    return false
  }
  if (input.hrcDbPath === undefined) {
    return false
  }

  const lookup = input.hasRecentlyCompletedHrcRunSince ?? defaultHasRecentlyCompletedHrcRunSince
  const evidence = lookup(
    input.hrcDbPath,
    run.hostSessionId,
    run.createdAt,
    launchCorrelationUntilIso(run.createdAt)
  )
  if (evidence === undefined) {
    return false
  }

  const expiresAt = terminalCorrelationGraceExpiresAt(evidence, input.config)
  if (expiresAt === undefined || Date.parse(expiresAt) <= nowMs) {
    return false
  }

  if (input.runStore !== undefined) {
    const observedAt = new Date(nowMs).toISOString()
    input.runStore.updateRun(run.runId, {
      metadata: {
        ...(run.metadata ?? {}),
        [DISPATCH_TIMEOUT_TERMINAL_GRACE_KEY]: {
          hrcRunId: evidence.runId,
          acceptedAt: evidence.acceptedAt,
          completedAt: evidence.completedAt,
          observedAt,
          expiresAt,
        } satisfies TerminalCorrelationGraceMarker,
      },
    })
  }

  return true
}

function readTerminalCorrelationGraceMarker(
  run: StoredRun
): TerminalCorrelationGraceMarker | undefined {
  const raw = run.metadata?.[DISPATCH_TIMEOUT_TERMINAL_GRACE_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  if (
    typeof record['hrcRunId'] !== 'string' ||
    typeof record['acceptedAt'] !== 'string' ||
    typeof record['completedAt'] !== 'string' ||
    typeof record['observedAt'] !== 'string' ||
    typeof record['expiresAt'] !== 'string'
  ) {
    return undefined
  }
  return {
    hrcRunId: record['hrcRunId'],
    acceptedAt: record['acceptedAt'],
    completedAt: record['completedAt'],
    observedAt: record['observedAt'],
    expiresAt: record['expiresAt'],
  }
}
