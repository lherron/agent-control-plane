import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { resolveDatabasePath } from 'hrc-core'

import type { LaunchRoleScopedRun } from './deps.js'

type Outcome = 'completed' | 'failed' | 'cancelled' | 'never'

type Sentinel = {
  outcome: Outcome
  text: string
}

const SENTINEL_OPEN = '<<<flow '
const SENTINEL_CLOSE = ' flow>>>'

export function createDevFlowLauncher(
  hrcDbPath: string = resolveDatabasePath()
): LaunchRoleScopedRun {
  return async ({ intent, runStore, acpRunId }) => {
    const hrcRunId = `dev-flow-${randomUUID().slice(0, 12)}`
    const sessionId = `dev-flow-session-${randomUUID().slice(0, 8)}`

    const prompt = typeof intent.initialPrompt === 'string' ? intent.initialPrompt : ''
    const sentinel = parseSentinel(prompt)

    if (sentinel.outcome === 'never') {
      if (acpRunId !== undefined && runStore !== undefined) {
        runStore.updateRun(acpRunId, { hrcRunId, status: 'running' })
      }
      return { runId: hrcRunId, sessionId }
    }

    if (acpRunId !== undefined && runStore !== undefined) {
      runStore.updateRun(acpRunId, { hrcRunId, status: sentinel.outcome })
    }

    insertHrcMessageEnd(hrcDbPath, hrcRunId, sentinel.text)

    return { runId: hrcRunId, sessionId }
  }
}

function parseSentinel(prompt: string): Sentinel {
  const open = prompt.indexOf(SENTINEL_OPEN)
  if (open === -1) {
    return { outcome: 'completed', text: `dev-flow-launcher reply: ${prompt}` }
  }
  const close = prompt.indexOf(SENTINEL_CLOSE, open + SENTINEL_OPEN.length)
  if (close === -1) {
    return { outcome: 'completed', text: `dev-flow-launcher reply: ${prompt}` }
  }
  const json = prompt.slice(open + SENTINEL_OPEN.length, close).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { outcome: 'failed', text: `dev-flow-launcher: malformed sentinel JSON: ${json}` }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { outcome: 'failed', text: 'dev-flow-launcher: sentinel must be a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  const outcomeRaw = typeof obj['outcome'] === 'string' ? obj['outcome'] : 'completed'
  const outcome = (
    outcomeRaw === 'completed' ||
    outcomeRaw === 'failed' ||
    outcomeRaw === 'cancelled' ||
    outcomeRaw === 'never'
      ? outcomeRaw
      : 'completed'
  ) as Outcome
  const text = typeof obj['text'] === 'string' ? obj['text'] : ''
  return { outcome, text }
}

function insertHrcMessageEnd(hrcDbPath: string, runId: string, text: string): void {
  const db = new Database(hrcDbPath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    const event = {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    }
    const ts = new Date().toISOString()
    db.prepare(
      `INSERT INTO events (
        ts, host_session_id, scope_ref, lane_ref, generation, run_id, runtime_id, source, event_kind, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).run(
      ts,
      `dev-flow-host-${runId}`,
      'agent:dev-flow-launcher',
      'main',
      1,
      runId,
      'dev-flow-launcher',
      'message_end',
      JSON.stringify(event)
    )
  } finally {
    db.close()
  }
}
