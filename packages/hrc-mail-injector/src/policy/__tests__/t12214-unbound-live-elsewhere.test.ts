/**
 * T-12214 — a node never fails mail for a scope that has a live runtime on
 * another node.
 *
 * An UNBOUND scope (no declared home, no registry binding, no designation) looks
 * local to `resolveForeignHome` on every node. Participant-only seats are the
 * live case: `stella@hrc-ios:primary-pulsar-2` runs on max3 and is unbound, so
 * svc took the launch door, HRC refused it as participant-only, and three such
 * refusals exhausted into `undeliverable` while max3 had already admitted it.
 *
 * Failure modes this guards:
 *  - the node without the runtime takes the launch door at all;
 *  - a participant-only refusal is charged as a launch failure and exhausts;
 *  - a scope with no runtime anywhere is never failed (the sender waits forever);
 *  - an unanswered peer or a failed federated read is read as "nothing live";
 *  - a scope bound HERE is skipped because a stale runtime lingers elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcConflictError, HrcErrorCode } from 'hrc-core'

import { driveMailTargetOnce } from '../drive/target-driver.js'
import {
  SCOPE_REF,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const PARTICIPANT_ONLY = `${SCOPE_REF} is participant-only, no seat registered. Register its direct participant before sending mail to this scope.`

let h: T08094Harness
let births = 0

beforeEach(async () => {
  h = await createT08094Harness()
  births = 0
  // Never seated on this node; HRC refuses its birth as participant-only.
  h.context.port.targetBySessionRef = async () => undefined
  h.context.port.allRuntimes = async () => []
  h.context.port.ensureTargetSession = async () => {
    births++
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, PARTICIPANT_ONLY, {
      scopeRef: SCOPE_REF,
      reason: 'participant-only',
      retryable: false,
    })
  }
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function liveOn(liveNodeIds: readonly string[], unansweredNodeIds: readonly string[] = []): void {
  h.context.port.federatedLiveRuntimes = async () => ({
    localNodeId: h.context.nodeId,
    liveNodeIds,
    unansweredNodeIds,
  })
}

function events(name: string) {
  return h.logs.filter((entry) => entry.event === name)
}

async function driveThreeTimes(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.context.mailKickerBirthSweepBackoff.clear()
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
  }
}

describe('T-12214 — unbound scope live on another node', () => {
  it('skips the target as foreign-homed instead of launching or failing it', async () => {
    const envelope = h.ledger.say()
    liveOn(['svc-peer'])

    await driveThreeTimes()

    expect(births).toBe(0)
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(h.store.launchFailures.get(envelope.id)).toBeUndefined()
    expect(
      events('wrkq.kicker.drive_phase').some(
        (entry) =>
          entry.detail['phase'] === 'home_resolution' &&
          entry.detail['outcome'] === 'skipped' &&
          entry.detail['reason'] === 'foreign_home' &&
          entry.detail['homeNodeId'] === 'svc-peer'
      )
    ).toBe(true)
    expect(events('wrkq.kicker.foreign_home_skipped')[0]?.detail).toMatchObject({
      scopeRef: SCOPE_REF,
      homeNodeId: 'svc-peer',
      source: 'federated-runtime',
    })
  })

  it('does not skip when the scope also has a live runtime here', async () => {
    h.ledger.say()
    liveOn([h.context.nodeId, 'svc-peer'])

    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')

    expect(births).toBe(1)
    expect(events('wrkq.kicker.foreign_home_skipped')).toHaveLength(0)
  })

  it('does not skip a scope bound to this node because a runtime lingers elsewhere', async () => {
    h.ledger.say()
    liveOn(['svc-peer'])
    h.context.port.localPlacementBindings = async () => ({
      localNodeId: h.context.nodeId,
      bindings: [
        {
          scopeRef: SCOPE_REF,
          state: 'active',
          homeNodeId: h.context.nodeId,
        } as never,
      ],
    })

    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')

    expect(births).toBe(1)
    expect(events('wrkq.kicker.foreign_home_skipped')).toHaveLength(0)
  })

  it('defers, never fails, when the federated read itself fails', async () => {
    const envelope = h.ledger.say()
    h.context.port.federatedLiveRuntimes = async () => {
      throw new Error('federation projection unavailable')
    }

    await driveThreeTimes()

    expect(births).toBe(0)
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
  })
})

describe('T-12214 — participant-only refusal is a placement fact', () => {
  it('fails the summons undeliverable at once when no node has a live runtime', async () => {
    const envelope = h.ledger.say()
    liveOn([])

    const outcome = await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(births).toBe(1)
    expect(outcome).toEqual({ outcome: 'undeliverable', failed: 1 })
    // The sender keeps the existing participant-only wording.
    expect(h.ledger.failRequests).toEqual([
      {
        envelope: envelope.id,
        reason: 'undeliverable',
        detail: `birth_failed: ${PARTICIPANT_ONLY}`,
      },
    ])
    expect(h.store.launchFailures.get(envelope.id)).toBeUndefined()
    expect(h.store.mailDelivery.listRefusedBirthTargets()).not.toContain(TARGET_REF)
  })

  it('leaves the envelope pending on the long backoff when a peer did not answer', async () => {
    const envelope = h.ledger.say()
    liveOn([], ['svc-peer'])

    await driveThreeTimes()

    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    // Never charged against the three-launch envelope bound.
    expect(h.store.launchFailures.get(envelope.id)).toBeUndefined()
    expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(events('wrkq.kicker.birth_not_placeable_here').length).toBeGreaterThan(0)
    expect(events('wrkq.kicker.drive_completed').at(-1)?.detail).toMatchObject({
      outcome: 'not_placeable_here',
    })
  })

  it('skips as foreign when the runtime appears elsewhere between the read and the refusal', async () => {
    const envelope = h.ledger.say()
    let reads = 0
    h.context.port.federatedLiveRuntimes = async () => ({
      localNodeId: h.context.nodeId,
      liveNodeIds: reads++ === 0 ? [] : ['svc-peer'],
      unansweredNodeIds: [],
    })

    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(births).toBe(1)
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(events('wrkq.kicker.foreign_home_skipped')[0]?.detail).toMatchObject({
      homeNodeId: 'svc-peer',
      source: 'federated-runtime',
    })
  })
})
