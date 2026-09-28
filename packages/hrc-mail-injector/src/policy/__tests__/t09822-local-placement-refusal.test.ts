/**
 * T-09822 — a node that cannot host a project leaves an unbound birth alone.
 *
 * Every node's injector drives the same ledger. For a scope no node has bound
 * yet, the node without the project's checkout reaches placements-resolve
 * first and HRC refuses it `declaration_invalid` / `source: project-targets`:
 * a fact about THIS node's filesystem, not about the declaration. T-09657
 * made that refusal terminal on first sight, so the race decided the mail's
 * fate. The node that CAN host the project must be left to birth it.
 *
 * Failure modes this guards:
 *  - the non-hosting node fails the summons (the T-09822 defect);
 *  - the non-hosting node's skip is silent: no node, HOME or root in the log;
 *  - T-09657's fast-fail is lost for a refusal that is invalid everywhere
 *    (task-worktree, EN-19323);
 *  - with no node able to host, the mail sits pending forever;
 *  - the no-host backstop fails mail a hosting node has since bound.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { driveMailTargetOnce } from '../drive/target-driver.js'
import { BIRTH_SWEEP_MAX_REFUSALS } from '../internal.js'
import { chargeBirthSweepRefusal } from '../wake/birth-retry.js'
import {
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const ROOT = '/Users/svc/praesidium/foundry'
const LOCAL_REFUSAL = `registered root for foundry ${ROOT} is not a canonical git checkout; repair it with: wrkq set foundry --root <canonical>`

function notHostedHere(detail: Record<string, unknown> = {}): HrcDomainError {
  return new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, LOCAL_REFUSAL, {
    source: 'project-targets',
    ...detail,
  })
}

let svc: T08094Harness
let max3: T08094Harness

beforeEach(async () => {
  svc = await createT08094Harness()
  max3 = await createT08094Harness()
  // Never born anywhere: no live runtime on either node.
  svc.context.port.allRuntimes = async () => []
  max3.context.port.allRuntimes = async () => []
  ;(svc.context as { nodeId: string }).nodeId = 'svc'
  // svc has no checkout: placement refuses before the summon gate.
  svc.context.port.resolveRuntimeIntent = async () => {
    throw notHostedHere({ projectId: 'foundry', projectRoot: ROOT, home: '/Users/svc' })
  }
})

afterEach(async () => {
  await destroyT08094Harness(svc)
  await destroyT08094Harness(max3)
})

function events(h: T08094Harness, name: string) {
  return h.logs.filter((entry) => entry.event === name)
}

describe('T-09822 — non-hosting node vs hosting node, same envelope', () => {
  it('the non-hosting node skips with a typed line; the hosting node births', async () => {
    const envelope = svc.ledger.say()
    max3.ledger.say({ id: envelope.id })

    const svcOutcome = await driveMailTargetOnce(svc.context, TARGET_REF, 'insert')
    const max3Outcome = await driveMailTargetOnce(max3.context, TARGET_REF, 'insert')

    // svc: nothing failed, nothing terminal, a positive skip line.
    expect(svcOutcome).toEqual({ outcome: 'birth-refused', notPlaceableHere: true })
    expect(svc.ledger.failRequests).toHaveLength(0)
    expect(events(svc, 'wrkq.kicker.birth_refusal_deterministic')).toHaveLength(0)
    expect(events(svc, 'wrkq.kicker.birth_not_placeable_here')[0]?.detail).toMatchObject({
      targetSessionRef: TARGET_REF,
      envelope: envelope.id,
      nodeId: 'svc',
      home: '/Users/svc',
      projectId: 'foundry',
      projectRoot: ROOT,
      source: 'project-targets',
    })
    expect(events(svc, 'wrkq.kicker.drive_completed')[0]?.detail).toMatchObject({
      outcome: 'not_placeable_here',
      terminalized: 0,
      recovery: 'periodic_wake',
    })
    // The refusal row stays open: it is the no-host backstop's only record.
    expect(svc.db.mailDelivery.listRefusedBirthTargets()).toContain(TARGET_REF)
    expect(svc.db.mailDelivery.getBirthRefusal(TARGET_REF)?.lastReason).toContain('svc')

    // max3: hosts the project and births on its FIRST drive. svc's refusal
    // row and backoff are svc's own store and memory; nothing of them reaches
    // max3, so no 1/2/4-minute wait is inherited (mable's condition).
    expect(max3Outcome).toBeUndefined()
    expect(max3.ledger.failRequests).toHaveLength(0)
    expect(events(max3, 'wrkq.kicker.delivery_intent')[0]?.detail).toMatchObject({
      envelope: envelope.id,
      door: 'launch',
    })
    expect(max3.db.mailDelivery.listRefusedBirthTargets()).not.toContain(TARGET_REF)
    expect(max3.context.mailKickerBirthSweepBackoff.has(TARGET_REF)).toBe(false)
  })

  it('falls back to the process HOME and the message when HRC sends no root', async () => {
    svc.ledger.say()
    svc.context.port.resolveRuntimeIntent = async () => {
      throw notHostedHere()
    }

    await driveMailTargetOnce(svc.context, TARGET_REF, 'insert')

    expect(svc.ledger.failRequests).toHaveLength(0)
    const line = events(svc, 'wrkq.kicker.birth_not_placeable_here')[0]?.detail
    expect(line).toMatchObject({ nodeId: 'svc', home: expect.any(String), message: LOCAL_REFUSAL })
  })

  it('once the hosting node binds the scope, the backstop fails nothing', async () => {
    svc.ledger.say()
    await driveMailTargetOnce(svc.context, TARGET_REF, 'periodic')
    svc.context.mailKickerBirthSweepBackoff.set(TARGET_REF, {
      attempts: BIRTH_SWEEP_MAX_REFUSALS - 1,
      nextAtMs: 0,
    })
    svc.context.port.locate = async () => ({ homeNodeId: 'max3' }) as never

    await chargeBirthSweepRefusal(svc.context, TARGET_REF)

    expect(svc.ledger.failRequests).toHaveLength(0)
  })

  it('no node can host: the fifth local refusal fails it with the reason', async () => {
    const envelope = svc.ledger.say()
    for (let strike = 1; strike <= BIRTH_SWEEP_MAX_REFUSALS; strike += 1) {
      const outcome = await driveMailTargetOnce(svc.context, TARGET_REF, 'periodic')
      expect(outcome).toMatchObject({ outcome: 'birth-refused' })
      await chargeBirthSweepRefusal(svc.context, TARGET_REF)
    }

    expect(svc.ledger.failRequests).toEqual([
      {
        envelope: envelope.id,
        reason: 'undeliverable',
        detail: expect.stringContaining(ROOT),
      },
    ])
    expect(svc.ledger.failRequests[0]?.detail).toContain('svc')
  })
})

describe('T-09822 — T-09657 fast-fail is kept for refusals invalid on every node', () => {
  it('CONTROL: a task-worktree refusal still fails at once (EN-19323)', async () => {
    const envelope = svc.ledger.say()
    svc.context.port.resolveRuntimeIntent = async () => {
      throw new HrcDomainError(
        HrcErrorCode.DECLARATION_INVALID,
        'worktree at /w/x-T-1 appears associated with T-1 but branch b does not carry T-1',
        { source: 'task-worktree' }
      )
    }

    const outcome = await driveMailTargetOnce(svc.context, TARGET_REF, 'insert')

    expect(outcome).toEqual({ outcome: 'undeliverable', failed: 1 })
    expect(svc.ledger.failRequests.map((request) => request.envelope)).toEqual([envelope.id])
    expect(events(svc, 'wrkq.kicker.birth_not_placeable_here')).toHaveLength(0)
  })

  it('CONTROL: an agent-profile refusal still fails at once', async () => {
    svc.ledger.say()
    svc.context.port.resolveRuntimeIntent = async () => {
      throw new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'agent "nope" was not found', {
        source: 'agent-profile',
        producerCode: 'agent_not_found',
      })
    }

    const outcome = await driveMailTargetOnce(svc.context, TARGET_REF, 'insert')

    expect(outcome).toMatchObject({ outcome: 'undeliverable' })
  })
})
