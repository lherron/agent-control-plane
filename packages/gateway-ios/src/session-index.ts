/**
 * GET /v1/sessions and POST /v1/sessions/refresh handlers.
 *
 * Fetches sessions, runtimes, and targets from HRC, merges into
 * MobileSessionSummary records, applies mode/status/q filters, and
 * returns a MobileSessionIndex.
 */

import { formatSessionHandle } from 'agent-scope'
import type { LaneRef } from 'agent-scope'
import type { HrcExecutionMode, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcTargetView } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type {
  MobileSessionCapabilities,
  MobileSessionIndex,
  MobileSessionMode,
  MobileSessionStatus,
  MobileSessionSummary,
} from './contracts.js'

/** Short-lived cache (5s TTL). */
type CacheEntry = {
  ts: number
  sessions: MobileSessionSummary[]
}

const CACHE_TTL_MS = 5_000

export type SessionIndexDeps = {
  client: HrcClient
}

/**
 * Creates the session index service with a short-lived in-memory cache.
 */
export function createSessionIndex(deps: SessionIndexDeps) {
  let cache: CacheEntry | null = null

  async function fetchAndMerge(): Promise<MobileSessionSummary[]> {
    const [sessions, runtimes, targets] = await Promise.all([
      deps.client.listSessions(),
      deps.client.listRuntimes(),
      deps.client.listTargets(),
    ])

    return mergeIntoSummaries(sessions, runtimes, targets)
  }

  async function getCachedSessions(): Promise<{
    refreshedAt: string
    sessions: MobileSessionSummary[]
  }> {
    const now = Date.now()
    if (cache && now - cache.ts < CACHE_TTL_MS) {
      return {
        refreshedAt: new Date(cache.ts).toISOString(),
        sessions: cache.sessions,
      }
    }

    const sessions = await fetchAndMerge()
    cache = { ts: now, sessions }
    return {
      refreshedAt: new Date(now).toISOString(),
      sessions,
    }
  }

  async function refresh(): Promise<{
    refreshedAt: string
    sessions: MobileSessionSummary[]
  }> {
    // Force bypass cache
    cache = null
    return getCachedSessions()
  }

  return {
    /** GET /v1/sessions — uses short-lived cache. */
    async handleListSessions(params: {
      mode?: string
      status?: string
      q?: string
    }): Promise<MobileSessionIndex> {
      const { refreshedAt, sessions } = await getCachedSessions()
      return applyFilters(refreshedAt, sessions, params)
    },

    /** POST /v1/sessions/refresh — force re-query, bypass cache. */
    async handleRefresh(params: {
      mode?: string
      status?: string
      q?: string
    }): Promise<MobileSessionIndex> {
      const { refreshedAt, sessions } = await refresh()
      return applyFilters(refreshedAt, sessions, params)
    },
  }
}

// ---------------------------------------------------------------------------
// Merge HRC data into MobileSessionSummary
// ---------------------------------------------------------------------------

function mergeIntoSummaries(
  sessions: HrcSessionRecord[],
  runtimes: HrcRuntimeSnapshot[],
  targets: HrcTargetView[]
): MobileSessionSummary[] {
  // Index runtimes by hostSessionId (most recent wins via sort)
  const runtimeByHost = new Map<string, HrcRuntimeSnapshot>()
  for (const rt of runtimes) {
    const existing = runtimeByHost.get(rt.hostSessionId)
    // Keep the most recently updated runtime per session
    if (!existing || rt.updatedAt > existing.updatedAt) {
      runtimeByHost.set(rt.hostSessionId, rt)
    }
  }

  // Index targets by sessionRef
  const targetByRef = new Map<string, HrcTargetView>()
  for (const t of targets) {
    targetByRef.set(t.sessionRef, t)
  }

  const summaries: MobileSessionSummary[] = []

  for (const session of sessions) {
    const sessionRef = `${session.scopeRef}/lane:${session.laneRef}`
    const runtime = runtimeByHost.get(session.hostSessionId) ?? null
    const _target = targetByRef.get(sessionRef) ?? null

    // Derive executionMode from session's lastAppliedIntentJson
    const executionMode: HrcExecutionMode =
      session.lastAppliedIntentJson?.execution?.preferredMode ?? 'interactive'

    // Mobile mode bucketing: headless + nonInteractive → 'headless'
    const mode: MobileSessionMode = executionMode === 'interactive' ? 'interactive' : 'headless'

    // Status derivation
    const status = deriveStatus(session, runtime)

    // Display ref formatting
    let displayRef: string
    try {
      displayRef = formatSessionHandle({
        scopeRef: session.scopeRef,
        laneRef: session.laneRef as LaneRef,
      })
    } catch {
      displayRef = sessionRef
    }

    // Title: agent ID from scope or session ref
    const title = extractTitle(session)

    // Capabilities
    const capabilities = deriveCapabilities(mode, status, runtime)

    summaries.push({
      sessionRef,
      displayRef,
      title,
      mode,
      executionMode,
      status,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime?.runtimeId ?? null,
      activeTurnId: runtime?.activeRunId ?? null,
      lastHrcSeq: 0, // Populated by event stream, not available from list APIs
      lastMessageSeq: 0,
      lastActivityAt: runtime?.lastActivityAt ?? null,
      capabilities,
    })
  }

  // Sort by lastActivityAt desc (most recent first), nulls last
  summaries.sort((a, b) => {
    if (a.lastActivityAt === null && b.lastActivityAt === null) return 0
    if (a.lastActivityAt === null) return 1
    if (b.lastActivityAt === null) return -1
    return b.lastActivityAt.localeCompare(a.lastActivityAt)
  })

  return summaries
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot | null
): MobileSessionStatus {
  if (!runtime) {
    return 'inactive'
  }

  const runtimeAlive = runtime.status === 'running' || runtime.status === 'starting'

  if (!runtimeAlive) {
    return 'inactive'
  }

  // Generation mismatch → stale
  if (runtime.generation !== session.generation) {
    return 'stale'
  }

  // Check for stale runtime based on transport status
  if (runtime.status === 'stale') {
    return 'stale'
  }

  return 'active'
}

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

function deriveCapabilities(
  mode: MobileSessionMode,
  status: MobileSessionStatus,
  runtime: HrcRuntimeSnapshot | null
): MobileSessionCapabilities {
  const isActive = status === 'active'
  const isInteractive = mode === 'interactive'

  return {
    input: isActive && isInteractive && (runtime?.supportsInflightInput ?? false),
    interrupt: isActive && isInteractive,
    launchHeadlessTurn: isActive && !isInteractive,
    history: true, // History is always available
  }
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

function extractTitle(session: HrcSessionRecord): string {
  // Extract agentId from scopeRef "agent:<agentId>[:project:<projectId>[:task:<taskId>]]"
  const parts = session.scopeRef.split(':')
  if (parts.length >= 2 && parts[0] === 'agent') {
    return parts[1] as string
  }
  return session.scopeRef
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function applyFilters(
  refreshedAt: string,
  allSessions: MobileSessionSummary[],
  params: { mode?: string; status?: string; q?: string }
): MobileSessionIndex {
  const modeFilter = params.mode ?? 'all'
  const statusFilter = params.status ?? 'all'
  const qFilter = params.q?.toLowerCase()

  // Step 1: Apply mode filter
  let modeFiltered = allSessions
  if (modeFilter !== 'all') {
    modeFiltered = allSessions.filter((s) => s.mode === modeFilter)
  }

  // Step 2: Compute counts on mode-filtered set (before q filter)
  const counts = {
    all: modeFiltered.length,
    interactive: modeFiltered.filter((s) => s.mode === 'interactive').length,
    headless: modeFiltered.filter((s) => s.mode === 'headless').length,
    active: modeFiltered.filter((s) => s.status === 'active').length,
    stale: modeFiltered.filter((s) => s.status === 'stale').length,
    inactive: modeFiltered.filter((s) => s.status === 'inactive').length,
  }

  // Step 3: Apply status filter
  let statusFiltered = modeFiltered
  if (statusFilter !== 'all') {
    statusFiltered = modeFiltered.filter((s) => s.status === statusFilter)
  }

  // Step 4: Apply q filter (case-insensitive substring match)
  let result = statusFiltered
  if (qFilter) {
    result = statusFiltered.filter(
      (s) =>
        s.title.toLowerCase().includes(qFilter) ||
        s.sessionRef.toLowerCase().includes(qFilter) ||
        s.displayRef.toLowerCase().includes(qFilter)
    )
  }

  return {
    refreshedAt,
    counts,
    sessions: result,
  }
}
