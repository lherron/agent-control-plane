/**
 * Card contract rev 5.8 §6d (c2-core 0.7.0, T-14629): work c2 sends Vesta while
 * she has a seat row but no running session goes by HRC's keyed steer, which
 * starts the seat, with the wake note on the line after. Through ACP's host this
 * is the mobile actions route reaching HRC's /v1/submissions/steer for Vesta.
 */
import { describe, expect, test } from 'bun:test'

import {
  ACTIONS,
  type ActionResponse,
  VESTA,
  newRequestId,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

const VESTA_REF = `${VESTA}/lane:main`
const NOTE = 'You had no running session, so this message started one.'

describe('rev 5.8 §6d: an offline Vesta is woken by a keyed steer', () => {
  test('delegate to a runtime-less Vesta is requested, sent as a steer keyed by the requestId', async () => {
    await withC2Acp(async (acp) => {
      const vesta = acp.fake.seats.get(VESTA)
      if (vesta === undefined) throw new Error('fixture vesta missing')
      vesta.runtimeLive = false
      acp.fake.touch(VESTA, 'runtime.state')
      await settle(200)
      const { entry } = await snapshotEntry(acp)
      const delegate = entry.actions.find((a) => a.kind === 'delegate')
      if (delegate === undefined) throw new Error('entry has no delegate action')
      const requestId = newRequestId()
      const { status, body } = await acp.postJson<ActionResponse>(ACTIONS, {
        requestId,
        key: entry.key,
        expectUpdatedAt: entry.expectUpdatedAt,
        actionId: delegate.id,
        kind: 'delegate',
        text: delegate.text,
        recommended: false,
        edited: false,
      })
      expect(status).toBe(200)
      expect(body.outcome).toBe('requested')
      const steers = acp.fake.calls.filter(
        (c) =>
          c.path === '/v1/submissions/steer' && (c.body as { target?: string }).target === VESTA_REF
      )
      expect(steers).toHaveLength(1)
      const steer = steers[0]?.body as { body: string; idempotencyKey: string }
      expect(steer.idempotencyKey).toBe(requestId)
      expect(steer.body.split('\n')).toEqual([delegate.text, NOTE])
      const fenced = acp.fake
        .literalInputs()
        .filter(
          (c) =>
            (c.body as { selector?: { sessionRef?: string } }).selector?.sessionRef === VESTA_REF
        )
      expect(fenced).toHaveLength(0)
    })
  })
})
