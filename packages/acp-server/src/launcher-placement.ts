import { Database } from 'bun:sqlite'
import type { SessionRef } from 'agent-scope'
import type { HrcHarnessIntent, HrcRuntimeIntent, ScopeLocation } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import {
  type FetchPlacementResolution,
  daemonHarnessToHrcHarness,
  fetchPlacementResolution,
} from './placement-resolution.js'

const UNAVAILABLE_TMUX_STATUSES = new Set(['terminated', 'stale', 'failed', 'exited'])
type LiveTmuxRuntime = {
  hostSessionId: string
  runtimeId: string
}

export async function assertPromptLaunchOwnedLocally(input: {
  client: Partial<Pick<HrcClient, 'locateScope'>>
  sessionRef: SessionRef
  prompt: string | undefined
  /** Set only when the jobs store vouches for this launch's job run. */
  jobRunId: string | undefined
}): Promise<'local' | 'job-first-birth'> {
  if (!input.prompt) {
    return 'local'
  }
  // Embedders may inject a partial legacy client. The installed HrcClient has
  // locateScope; preserve the legacy local path only for those partial doubles.
  if (typeof input.client.locateScope !== 'function') {
    return 'local'
  }

  const location = await input.client.locateScope(input.sessionRef.scopeRef)
  if (!requiresCollaborationLedgerDelivery(location)) {
    return 'local'
  }
  if (location.authority.state === 'unbound' && input.jobRunId !== undefined) {
    return 'job-first-birth'
  }

  throw new Error(
    `prompt delivery for ${toHrcSessionRef(input.sessionRef)} is owned by the collaboration ledger; ACP local launch refused`
  )
}

function requiresCollaborationLedgerDelivery(location: ScopeLocation): boolean {
  switch (location.authority.state) {
    case 'bound':
      return !location.authority.isLocal
    case 'unbound':
      // The HRC ledger kicker, not ACP, owns first-birth placement and summon.
      return true
    case 'unknown':
      // Preserve the ordinary resolve-session gate's typed availability cause.
      return false
  }
}

export async function normalizeRealLauncherIntent(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  liveTmuxRuntime?: boolean | undefined
  socketPath?: string | undefined
  fetchPlacement?: FetchPlacementResolution | undefined
}): Promise<HrcRuntimeIntent> {
  const inferredHarness = input.intent.harness ?? (await inferHarnessIntent(input))
  const preferredMode = input.liveTmuxRuntime
    ? ('interactive' as const)
    : (input.intent.execution?.preferredMode ??
      (input.intent.harness !== undefined || inferredHarness.interactive
        ? ('headless' as const)
        : undefined))
  const normalizedExecution =
    preferredMode === undefined
      ? input.intent.execution
      : {
          ...input.intent.execution,
          preferredMode,
        }
  const harness = inferredHarness
  const normalizedHarness =
    preferredMode === 'interactive'
      ? { ...harness, interactive: true }
      : preferredMode === 'headless' || preferredMode === 'nonInteractive'
        ? { ...harness, interactive: false }
        : harness

  return {
    ...input.intent,
    placement: {
      ...input.intent.placement,
      ...(input.intent.placement.dryRun === undefined ? { dryRun: false } : {}),
    },
    harness: normalizedHarness,
    ...(normalizedExecution !== undefined ? { execution: normalizedExecution } : {}),
  }
}

export function findLiveTmuxRuntimeForSessionRef(
  hrcDbPath: string,
  sessionRef: SessionRef
): LiveTmuxRuntime | undefined {
  if (hrcDbPath === ':memory:') {
    return undefined
  }

  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const continuity = db
      .query<{ hostSessionId: string }, [string, string]>(
        `SELECT active_host_session_id AS hostSessionId
          FROM continuities
          WHERE scope_ref = ? AND lane_ref = ?`
      )
      .get(sessionRef.scopeRef, sessionRef.laneRef)
    const hostSessionId = continuity?.hostSessionId
    if (hostSessionId === undefined) {
      return undefined
    }

    const runtime = db
      .query<{ runtimeId: string; status: string }, [string]>(
        `SELECT runtime_id AS runtimeId, status
          FROM runtimes
          WHERE host_session_id = ?
            AND transport = 'tmux'
            AND tmux_json IS NOT NULL
          ORDER BY updated_at DESC`
      )
      .all(hostSessionId)
      .find((row) => !UNAVAILABLE_TMUX_STATUSES.has(row.status))

    return runtime === undefined ? undefined : { hostSessionId, runtimeId: runtime.runtimeId }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

async function inferHarnessIntent(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  socketPath?: string | undefined
  fetchPlacement?: FetchPlacementResolution | undefined
}): Promise<HrcHarnessIntent> {
  const placement = input.intent.placement
  const fetch = input.fetchPlacement ?? fetchPlacementResolution
  const fetchOpts: { socketPath?: string | undefined } = {}
  if (input.socketPath !== undefined) fetchOpts.socketPath = input.socketPath
  const resolved = await fetch(
    {
      scopeRef: input.sessionRef.scopeRef,
      agentRoot: placement.agentRoot,
      ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
      ...(placement.cwd !== undefined ? { cwd: placement.cwd } : {}),
      ...(placement.runMode !== undefined ? { runMode: placement.runMode } : {}),
    },
    fetchOpts
  )
  return daemonHarnessToHrcHarness(resolved.harness)
}

export function toHrcSessionRef(sessionRef: SessionRef): string {
  return `${sessionRef.scopeRef}/lane:${sessionRef.laneRef}`
}
