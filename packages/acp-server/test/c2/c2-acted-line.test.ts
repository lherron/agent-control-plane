/**
 * The acted line (card contract rev 4 §6). After a delivered `answer` or `compose`, ACP sends the live
 * configured Vesta seat exactly
 *   `[c2] acted <scopeRef> <actionId> recommended=<bool> edited=<bool> run=<run_id|accepted>[ answers=…]`
 * through the generation-fenced literal input. Best effort: never retried or queued, skipped when Vesta is
 * offline, never sent for refusals, unknown outcomes, replays or jump; its failure never changes the outcome.
 */
import { describe, expect, test } from 'bun:test'

import {
  ACTIONS,
  ASK,
  type ActionResponse,
  type C2Acp,
  SEAT,
  VESTA,
  answerRequest,
  newRequestId,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

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
  test('a delivered answer sends Vesta the exact fenced line once', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('sent')
      await settle()
      expect(vestaLines(acp)).toEqual([
        {
          selector: { sessionRef: VESTA_REF },
          text: `[c2] acted ${SEAT} answers recommended=true edited=false run=${body.receipt?.runId} answers=ship:Ship*`,
          enter: true,
          fences: { expectedHostSessionId: 'hsid-vesta-fixture', expectedGeneration: 3 },
        } as never,
      ])
    })
  })

  test('edited text is reported edited=true from the server-derived value', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      await acp.postJson<ActionResponse>(
        ACTIONS,
        answerRequest(entry, { text: `1. ${ASK} — Ship today.`, edited: false })
      )
      await settle()
      expect(vestaLines(acp)[0]?.text).toContain('edited=true')
    })
  })

  test('accepted delivery without a runId reads run=accepted', async () => {
    await withC2Acp(async (acp) => {
      acp.fake.literalInput.mode = 'accept-no-run'
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('accepted')
      await settle()
      expect(vestaLines(acp).map((l) => l.text)).toEqual([
        `[c2] acted ${SEAT} answers recommended=true edited=false run=accepted answers=ship:Ship*`,
      ])
    })
  })

  test('a replay never sends a second line; jump and refusals send none', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const request = answerRequest(entry)
      await acp.postJson(ACTIONS, request)
      await acp.postJson(ACTIONS, request)
      await acp.postJson(ACTIONS, answerRequest(entry)) // card_not_open: the row is sent
      await acp.postJson(ACTIONS, {
        requestId: newRequestId(),
        key: entry.key,
        expectUpdatedAt: entry.expectUpdatedAt,
        actionId: 'jump',
        kind: 'jump',
        recommended: false,
        edited: false,
      })
      await settle()
      expect(vestaLines(acp)).toHaveLength(1)
    })
  })

  test('an offline Vesta gets no line and the answer still succeeds', async () => {
    await withC2Acp(async (acp) => {
      const vesta = acp.fake.seats.get(VESTA)
      if (vesta === undefined) throw new Error('fixture vesta missing')
      vesta.runtimeLive = false
      acp.fake.touch(VESTA, 'runtime.state')
      await settle(200)
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('sent')
      await settle()
      expect(vestaLines(acp)).toHaveLength(0)
    })
  })

  test('an unknown outcome sends no acted line', async () => {
    await withC2Acp(
      async (acp) => {
        acp.fake.literalInput.mode = 'hang'
        const { entry } = await snapshotEntry(acp)
        const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
        expect(body.outcome).toBe('unknown_outcome')
        acp.fake.literalInput.mode = 'accept'
        await settle()
        expect(vestaLines(acp)).toHaveLength(0)
      },
      { config: { literalInputTimeoutMs: 150 } }
    )
  })
})
