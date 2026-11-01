/**
 * Phase R red, flips in phase G: each test.failing becomes test(...) as it
 * goes green (Bun fails a test.failing that passes).
 *
 * T-12207 Work step 6: an HRC literal-input call that is accepted on the local
 * socket and never answered. After the call was made the outcome is
 * indeterminate: `unknown_outcome`, exactly one attempt, the receipt left at
 * `dispatching` and its card locked. Never `not_submitted`, never retried.
 */
import { expect, test } from 'bun:test'

import {
  type ActionResponse,
  SEAT,
  type Snapshot,
  reconcilePath,
  replyRequest,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

test.failing(
  'a literal-input timeout is unknown_outcome with one attempt, receipt dispatching and card locked',
  async () => {
    await withC2Acp(
      async (acp) => {
        const { card } = await snapshotCard(acp)
        acp.fake.literalInput.mode = 'hang'
        const request = replyRequest(card)

        const started = Date.now()
        const { status, body } = await acp.postJson<ActionResponse>(
          '/v1/mobile/c2/actions',
          request
        )
        expect(Date.now() - started).toBeLessThan(5000)
        expect(status).toBe(200)
        expect(body.ok).toBe(false)
        expect(body.outcome).toBe('unknown_outcome')
        expect(body.requestId).toBe(request.requestId)
        expect(acp.fake.literalInputs()).toHaveLength(1)

        // Several poll periods later: no retry, no recovery resend, nothing finished.
        await settle(1000)
        expect(acp.fake.literalInputs()).toHaveLength(1)
        const receipt = acp.fake.find(SEAT, 'receipt', request.requestId, 2)
        expect(receipt?.body['stage']).toBe('dispatching')
        const pending = acp.card().body['pending'] as { requestId?: string } | undefined
        expect(pending?.requestId).toBe(request.requestId)
        expect(acp.card().body['state']).toBe('open')
        expect(
          acp.fake.ledger.filter((event) => event.eventKind === 'session.annotation.action')
        ).toHaveLength(0)

        // Replay and reconciliation both answer unknown and execute nothing.
        const replay = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
        expect(replay.body.outcome).toBe('unknown_outcome')
        expect(replay.body.replayed).toBe(true)
        const readback = await acp.getJson<ActionResponse>(
          reconcilePath(request.requestId, request.key)
        )
        expect(readback.body.outcome).toBe('unknown_outcome')

        // The lock holds against a fresh request on the same card.
        const fresh = await acp.postJson<ActionResponse>(
          '/v1/mobile/c2/actions',
          replyRequest(card)
        )
        expect(fresh.body.outcome).toBe('card_not_open')
        expect(acp.fake.literalInputs()).toHaveLength(1)

        // The phone sees the row pending (disabled), not gone.
        const { body: snapshot } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
        const row = snapshot.seats.find((seat) => seat.scopeRef === SEAT)?.card
        expect(row?.pending?.requestId).toBe(request.requestId)
      },
      { config: { literalInputTimeoutMs: 250, pollMs: 50 } }
    )
  }
)

test.failing(
  'the dispatching lock survives a Vesta wholesale re-put that drops pending',
  async () => {
    await withC2Acp(
      async (acp) => {
        const { card } = await snapshotCard(acp)
        acp.fake.literalInput.mode = 'hang'
        const request = replyRequest(card)
        await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)

        const { pending: _dropped, ...rest } = acp.card().body
        acp.fake.put({ scopeRef: SEAT, generation: 2, kind: 'card', id: card.key.id, body: rest })
        await settle(600)

        const { body: snapshot } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
        const row = snapshot.seats.find((seat) => seat.scopeRef === SEAT)?.card
        expect(row?.pending?.requestId).toBe(request.requestId)
        const fresh = await acp.postJson<ActionResponse>(
          '/v1/mobile/c2/actions',
          replyRequest(row ?? card)
        )
        expect(fresh.body.outcome).toBe('card_not_open')
        expect(acp.fake.literalInputs()).toHaveLength(1)
      },
      { config: { literalInputTimeoutMs: 250, pollMs: 50 } }
    )
  }
)
