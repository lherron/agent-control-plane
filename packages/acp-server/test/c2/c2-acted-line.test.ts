/**
 * The acted line (c2 card-contract §6; EN-40120/EN-40123). After a delivered
 * reply, choose or compose WITH a runId, ACP's POST /actions sends the live
 * configured Vesta seat exactly
 *   `[c2] acted <card-id> <actionId> recommended=<bool> edited=<bool> run=<run_id>`
 * through the generation-fenced literal input. Best effort: never retried or
 * queued, skipped when Vesta is offline or there is no runId, never sent for
 * refusals, unknown outcomes, replays, jump or snooze; its failure never
 * changes the action's outcome.
 */
import { describe, expect, test } from 'bun:test'

import {
  ATTENTION_AT,
  type ActionResponse,
  type C2Acp,
  REPLY_TEXT,
  SEAT,
  VESTA,
  newRequestId,
  replyRequest,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

const CARD_ID = `${SEAT}#2#${ATTENTION_AT}`
const VESTA_REF = `${VESTA}/lane:main`

function vestaLines(acp: C2Acp): Array<{ text?: string; fences?: unknown; enter?: boolean }> {
  return acp.fake
    .literalInputs()
    .map(
      (call) =>
        call.body as {
          selector?: { sessionRef?: string }
          text?: string
          fences?: unknown
          enter?: boolean
        }
    )
    .filter((body) => body.selector?.sessionRef === VESTA_REF)
}

describe('the acted line', () => {
  test('a delivered reply with a runId sends Vesta the exact fenced line once', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const { body } = await acp.postJson<ActionResponse>(
        '/v1/mobile/c2/actions',
        replyRequest(card)
      )
      expect(body.outcome).toBe('sent')
      await settle()
      expect(vestaLines(acp)).toEqual([
        {
          selector: { sessionRef: VESTA_REF },
          text: `[c2] acted ${CARD_ID} ship recommended=true edited=false run=run-fake-1`,
          enter: true,
          fences: { expectedHostSessionId: 'hsid-vesta-fixture', expectedGeneration: 3 },
        },
      ])
    })
  })

  test('edited text is reported edited=true from the server-derived value', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      await acp.postJson(
        '/v1/mobile/c2/actions',
        replyRequest(card, { text: `${REPLY_TEXT} Tag it.`, edited: false })
      )
      await settle()
      expect(vestaLines(acp).map((line) => line.text)).toEqual([
        `[c2] acted ${CARD_ID} ship recommended=true edited=true run=run-fake-1`,
      ])
    })
  })

  test('a replay never sends a second acted line', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card)
      await acp.postJson('/v1/mobile/c2/actions', request)
      await settle()
      const replay = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(replay.body.replayed).toBe(true)
      await settle()
      expect(vestaLines(acp)).toHaveLength(1)
    })
  })

  test('accepted delivery without a runId sends no acted line', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      acp.fake.literalInput.mode = 'accept-no-run'
      const { body } = await acp.postJson<ActionResponse>(
        '/v1/mobile/c2/actions',
        replyRequest(card)
      )
      expect(body.outcome).toBe('accepted')
      await settle()
      expect(vestaLines(acp)).toHaveLength(0)
    })
  })

  test('an offline Vesta gets no line and the reply still succeeds', async () => {
    await withC2Acp(async (acp) => {
      const vesta = acp.fake.seats.get(VESTA)
      if (vesta === undefined) throw new Error('fixture Vesta missing')
      vesta.runtimeLive = false
      const { card } = await snapshotCard(acp)
      const { body } = await acp.postJson<ActionResponse>(
        '/v1/mobile/c2/actions',
        replyRequest(card)
      )
      expect(body.outcome).toBe('sent')
      await settle()
      expect(vestaLines(acp)).toHaveLength(0)
    })
  })

  test('a refused acted line is not retried and does not change the outcome', async () => {
    await withC2Acp(async (acp) => {
      acp.fake.literalInput.refuse.add(VESTA)
      const { card } = await snapshotCard(acp)
      const { body } = await acp.postJson<ActionResponse>(
        '/v1/mobile/c2/actions',
        replyRequest(card)
      )
      expect(body.ok).toBe(true)
      expect(body.outcome).toBe('sent')
      await settle(600)
      expect(vestaLines(acp)).toHaveLength(1)
      expect(acp.card().body['state']).toBe('sent')
    })
  })

  test('refusals, unknown outcomes, jump and snooze send no acted line', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      // refusal: stale card
      await acp.postJson(
        '/v1/mobile/c2/actions',
        replyRequest(card, { expectUpdatedAt: '2000-01-01T00:00:00.000Z' })
      )
      // jump and snooze
      for (const kind of ['jump', 'snooze']) {
        const { card: current } = await snapshotCard(acp)
        const action = current.actions.find((candidate) => candidate.kind === kind)
        await acp.postJson('/v1/mobile/c2/actions', {
          requestId: newRequestId(),
          key: current.key,
          expectUpdatedAt: current.updatedAt,
          actionId: action?.id,
          kind,
          recommended: false,
          edited: false,
        })
      }
      await settle()
      expect(vestaLines(acp)).toHaveLength(0)
    })
  })

  test('an unknown outcome sends no acted line', async () => {
    await withC2Acp(
      async (acp) => {
        const { card } = await snapshotCard(acp)
        acp.fake.literalInput.mode = 'hang'
        const { body } = await acp.postJson<ActionResponse>(
          '/v1/mobile/c2/actions',
          replyRequest(card)
        )
        expect(body.outcome).toBe('unknown_outcome')
        await settle()
        expect(vestaLines(acp)).toHaveLength(0)
      },
      { config: { literalInputTimeoutMs: 250 } }
    )
  })
})
