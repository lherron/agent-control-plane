/**
 * T-12207 scope CLI path (C2 rev 4 D5 / gate 5b through ACP): the scope row on
 * the Vesta seat, written by `writeC2Scope` as agent:lance over hrc-sdk, hides
 * an excluded seat's card from `/v1/mobile/c2/cards` and refuses actions on it;
 * widening brings it back. Malformed patterns never reach HRC.
 */
import { expect, test } from 'bun:test'

import { HrcClient } from 'hrc-sdk'

import { type C2ScopeClient, readC2Scope, writeC2Scope } from '../../src/c2/scope.js'

import {
  type ActionResponse,
  SCOPE_ALLOW,
  SEAT,
  type Snapshot,
  VESTA,
  replyRequest,
  seatSends,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

test('narrowing the scope row hides and refuses the card; widening restores it', async () => {
  await withC2Acp(async (acp) => {
    const scope = new HrcClient({ socketPath: acp.fake.socketPath }) as unknown as C2ScopeClient
    const { card } = await snapshotCard(acp)

    const before = await readC2Scope(scope, VESTA)
    expect(before).toMatchObject({ vestaSeat: VESTA, present: true, allow: SCOPE_ALLOW })

    const narrowed = await writeC2Scope(scope, VESTA, ['^agent:nobody:project:c2:task:x$'])
    expect(narrowed.allow).toEqual(['^agent:nobody:project:c2:task:x$'])
    expect(narrowed.updatedBy).toBe('agent:lance')
    await settle(200)
    const { body: hidden } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
    expect(hidden.seats.some((seat) => seat.scopeRef === SEAT)).toBe(false)
    const refused = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', replyRequest(card))
    expect(refused.body.outcome).toBe('card_not_open')
    expect(seatSends(acp)).toHaveLength(0)

    await writeC2Scope(scope, VESTA, SCOPE_ALLOW)
    await settle(200)
    const { card: back } = await snapshotCard(acp)
    expect(back.key).toEqual(card.key)
  })
})

test('an invalid pattern is refused before any HRC write', async () => {
  await withC2Acp(async (acp) => {
    const scope = new HrcClient({ socketPath: acp.fake.socketPath }) as unknown as C2ScopeClient
    const writes = acp.fake.writes().length
    await expect(writeC2Scope(scope, VESTA, ['(unclosed'])).rejects.toThrow(/invalid allow pattern/)
    expect(acp.fake.writes()).toHaveLength(writes)
  })
})
