import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { observeBrokerSeat } from '../drive/seat.js'
import type { T08094Harness } from './t08094-harness.js'
import { RUNTIME_ID, createT08094Harness, destroyT08094Harness } from './t08094-harness.js'

/**
 * T-10286 — a broker runtime whose invocation ended (`failed`, `stopped`,
 * `disposed`, `exited`) keeps its activeInvocationId. The kicker used to select
 * it as the seat, probe it, read `unavailable`, and defer every wake forever,
 * so the seat never re-birthed and its mail sat pending (8h on T-10232).
 * Every status HRC classifies `runtime-dead` must read as an absent seat.
 */

let harness: T08094Harness

beforeEach(async () => {
  harness = await createT08094Harness()
})

afterEach(async () => {
  await destroyT08094Harness(harness)
})

function brokerRuntimeIn(status: string): void {
  const now = new Date().toISOString()
  harness.db.runtimes.update(RUNTIME_ID, {
    controllerKind: 'harness-broker',
    activeInvocationId: 'inv-t10286',
    status,
    statusChangedAt: now,
    updatedAt: now,
  })
}

describe('T-10286 terminal broker runtime is not a seat', () => {
  // Control: the same row in a live status is selected and its failed probe
  // reads `unavailable`, so an `absent` below is the status filter's doing.
  it('selects a live broker runtime whose probe fails as unavailable', async () => {
    brokerRuntimeIn('ready')
    const seat = await observeBrokerSeat(harness.context, harness.session)
    expect(seat).toMatchObject({ state: 'unavailable', runtimeId: RUNTIME_ID })
  })

  for (const status of ['failed', 'stopped', 'disposed', 'exited', 'crashed', 'detached']) {
    it(`reads a ${status} broker runtime as an absent seat`, async () => {
      brokerRuntimeIn(status)
      expect(await observeBrokerSeat(harness.context, harness.session)).toEqual({ state: 'absent' })
    })
  }
})
