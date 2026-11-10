/**
 * HRC's `cwd_missing` refusal is terminal for the drive (T-12977 Part 1).
 *
 * Since hrc-runtime T-12976, HRC refuses a launch or resume whose working
 * directory is gone — a finished task's removed worktree — with a typed 422
 * `cwd_missing` before any broker starts. Nothing was written, and nothing
 * about the target changes between sweeps, so retrying only re-drives the same
 * refusal on every periodic wake. The envelope fails once, naming the path.
 *
 * The error shape is the one the pinned hrc-sdk raised against an isolated
 * rusthrc at the T-12976 commit (artifact: p1-before-open-fyi.json).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcDomainError } from 'hrc-core'

import { driveMailTargetOnce } from '../drive/target-driver.js'
import {
  HOST_SESSION_ID,
  SCOPE_REF,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const CWD = '/Users/lherron/praesidium/under-construction/agent-control-plane-T-08094'
let h: T08094Harness

function cwdMissing(): HrcDomainError {
  return new HrcDomainError(
    'cwd_missing' as never,
    `cannot start session ${HOST_SESSION_ID} (${SCOPE_REF}): working directory does not exist: ${CWD}`,
    { cwd: CWD, hostSessionId: HOST_SESSION_ID, scopeRef: SCOPE_REF, retryable: false }
  )
}

beforeEach(async () => {
  h = await createT08094Harness()
  // HRC refused before preparing a start: nothing is live for the scope.
  h.context.port.liveRuntimes = async () => []
  h.context.port.enqueue = async () => {
    throw cwdMissing()
  }
  h.context.port.invoke = async () => {
    throw cwdMissing()
  }
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function doors(): unknown[] {
  return h.logs
    .filter((entry) => entry.event === 'wrkq.kicker.delivery_intent')
    .map((entry) => (entry.detail as Record<string, unknown>)['door'])
}

describe('T-12977 Part 1 — cwd_missing fails the envelope once', () => {
  it('a reply_required birth into a removed worktree fails once, naming the path', async () => {
    const summons = h.ledger.say()

    expect(await driveMailTargetOnce(h.context, TARGET_REF, 'insert')).toMatchObject({
      outcome: 'undeliverable',
      failed: 1,
    })
    expect(doors()).toEqual(['launch'])
    expect(h.ledger.failRequests).toHaveLength(1)
    expect(h.ledger.failRequests[0]).toMatchObject({
      envelope: summons.id,
      reason: 'undeliverable',
    })
    expect(h.ledger.failRequests[0]?.detail).toContain('cwd_missing')
    expect(h.ledger.failRequests[0]?.detail).toContain(CWD)
    expect(h.store.mailDelivery.getIntent(summons.id)).toBeUndefined()

    // The next periodic wake has nothing left to drive.
    expect(await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')).toEqual({
      outcome: 'empty',
    })
    expect(doors()).toEqual(['launch'])
    expect(h.ledger.failRequests).toHaveLength(1)
  })

  it('an open task fyi resumed into a removed worktree fails once, naming the path', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })

    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(doors()).toEqual(['enqueue'])
    expect(h.ledger.failRequests).toHaveLength(1)
    expect(h.ledger.failRequests[0]).toMatchObject({ envelope: fyi.id, reason: 'undeliverable' })
    expect(h.ledger.failRequests[0]?.detail).toContain('cwd_missing')
    expect(h.ledger.failRequests[0]?.detail).toContain(CWD)
    expect(h.store.mailDelivery.getIntent(fyi.id)).toBeUndefined()

    expect(await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')).toEqual({
      outcome: 'empty',
    })
    expect(doors()).toEqual(['enqueue'])
    expect(h.ledger.failRequests).toHaveLength(1)
  })
})
