/**
 * T-12207 phase R: the four `/v1/mobile/c2/*` routes on an ephemeral ACP.
 * Wire law: hrc-ios `architecture/contracts/C2_MOBILE_CARDS.md` r2.1 (d977bc2).
 * External acceptance target: hrc-ios `scripts/c2-mobile-contract-e2e.py`.
 */
import { describe, expect, test } from 'bun:test'

import { createAcpListenerHandlers } from '../../src/acp-listener.js'
import { resolveAcpServerDeps } from '../../src/deps.js'
import { createMobileAuthStore } from '../../src/mobile-auth/store.js'

import {
  ATTENTION_AT,
  type ActionResponse,
  NODE,
  REPLY_TEXT,
  SEAT,
  SEAT_REF,
  type Snapshot,
  VESTA,
  newRequestId,
  reconcilePath,
  replyRequest,
  seatSends,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

describe('GET /v1/mobile/c2/cards', () => {
  test('returns the full snapshot for an in-scope seat with server-side text and opaque artifacts', async () => {
    await withC2Acp(async (acp) => {
      const { status, body } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(typeof body.revision).toBe('string')
      expect(body.revision.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(body.asOf))).toBe(false)
      expect(body.home).toMatchObject({ node: NODE, reachable: true, stale: false })
      expect(body.vesta).toMatchObject({
        online: true,
        sessionRef: `${VESTA}/lane:main`,
        hostSessionId: 'hsid-vesta-fixture',
        generation: 3,
      })
      expect(body.capabilities.artifacts).toBe(true)
      expect(body.capabilities.longPoll).toBe(true)
      expect(body.capabilities.actions).toEqual(expect.arrayContaining(['reply', 'jump', 'snooze']))

      const row = body.seats.find((seat) => seat.scopeRef === SEAT)
      expect(row).toMatchObject({
        agent: 'smokey',
        project: 'c2',
        seat: 'c2fixture-acp',
        online: true,
      })
      expect(body.seats.filter((seat) => seat.scopeRef === SEAT)).toHaveLength(1)
      const card = row?.card
      expect(card).not.toBeNull()
      expect(card?.key).toEqual({
        sessionRef: SEAT_REF,
        subject: 'generation',
        generation: 2,
        ns: 'c2',
        kind: 'card',
        id: ATTENTION_AT,
      })
      expect(card?.id).toBe(`${SEAT}#2#${ATTENTION_AT}`)
      expect(card?.state).toBe('open')
      expect(card?.pending).toBeNull()
      expect(card?.updatedAt).toBe(acp.card().updatedAt)
      expect(card?.seat).toMatchObject({
        node: NODE,
        scopeRef: SEAT,
        sessionRef: SEAT_REF,
        hostSessionId: 'hsid-c2fixture-acp',
        generation: 2,
        attentionAt: ATTENTION_AT,
        online: true,
      })
      // Every declared action carries a server-normalized id; reply carries its exact text.
      for (const action of card?.actions ?? []) expect(action.id.length).toBeGreaterThan(0)
      expect(card?.actions.find((action) => action.kind === 'reply')?.text).toBe(REPLY_TEXT)
      expect(card?.actions.some((action) => action.kind === 'jump')).toBe(true)

      const image = card?.evidence.find((item) => item.label === 'look')?.image
      expect(typeof image?.artifact).toBe('string')
      expect(card?.detail.status).toBe('ready')
      expect(typeof card?.detail.artifact).toBe('string')
      // Home paths never reach the mobile DTO.
      expect(JSON.stringify(body)).not.toContain(acp.roots.wrkqArtifacts)
      expect(JSON.stringify(body)).not.toContain(acp.roots.scratchC2)

      expect(body.counts).toEqual({ waiting: 1, asks: 0 })
      expect(body.asks).toEqual([])
      expect(body.recent.length).toBeLessThanOrEqual(50)
    })
  })

  test('an absent scope row allows nothing: the card does not project', async () => {
    await withC2Acp(
      async (acp) => {
        const { status, body } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
        expect(status).toBe(200)
        expect(body.seats.some((seat) => seat.card !== null)).toBe(false)
        expect(body.counts.waiting).toBe(0)
      },
      { noScope: true }
    )
  })

  test('a bounded long poll answers unchanged at its deadline with the same revision', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot } = await snapshotCard(acp)
      const started = Date.now()
      const { status, body } = await acp.getJson<Snapshot>(
        `/v1/mobile/c2/cards?after=${encodeURIComponent(snapshot.revision)}&waitMs=400`
      )
      const elapsed = Date.now() - started
      expect(status).toBe(200)
      expect(body).toEqual({ ok: true, unchanged: true, revision: snapshot.revision })
      expect(elapsed).toBeGreaterThanOrEqual(350)
      expect(elapsed).toBeLessThan(5000)
    })
  })

  test('a long poll returns the full snapshot early when a card changes in HRC', async () => {
    await withC2Acp(
      async (acp) => {
        const { snapshot } = await snapshotCard(acp)
        const started = Date.now()
        const pending = acp.getJson<Snapshot>(
          `/v1/mobile/c2/cards?after=${encodeURIComponent(snapshot.revision)}&waitMs=20000`
        )
        await settle(200)
        // Vesta re-puts her card with a new title.
        acp.fake.put({
          scopeRef: SEAT,
          generation: 2,
          kind: 'card',
          id: ATTENTION_AT,
          body: { ...acp.card().body, title: 'Ship it now?' },
        })
        const { status, body } = await pending
        expect(status).toBe(200)
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(body.unchanged).toBeUndefined()
        expect(body.revision).not.toBe(snapshot.revision)
        expect(body.seats.find((seat) => seat.scopeRef === SEAT)?.card?.title).toBe('Ship it now?')
      },
      { config: { pollMs: 50 } }
    )
  })

  test('waitMs above 25000 is malformed', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot } = await snapshotCard(acp)
      const response = await acp.get(
        `/v1/mobile/c2/cards?after=${encodeURIComponent(snapshot.revision)}&waitMs=25001`
      )
      expect(response.status).toBe(400)
    })
  })

  test('with HRC gone it serves the last snapshot marked stale, and actions are not_submitted', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot, card } = await snapshotCard(acp)
      await acp.fake.stop()
      await settle(300)
      const { status, body } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
      expect(status).toBe(200)
      expect(body.home).toMatchObject({ node: NODE, reachable: false, stale: true })
      expect(body.seats.find((seat) => seat.scopeRef === SEAT)?.card?.key).toEqual(card.key)
      expect(body.revision).toBe(snapshot.revision)

      // A refused connect is provably pre-dispatch.
      const action = await acp.post('/v1/mobile/c2/actions', replyRequest(card))
      expect([200, 503]).toContain(action.status)
      const result = (await action.json()) as ActionResponse
      expect(result.ok).toBe(false)
      expect(result.outcome).toBe('not_submitted')
    })
  })

  test('with no prior snapshot and HRC gone it answers 503 home_unavailable', async () => {
    await withC2Acp(
      async (acp) => {
        const { status, body } = await acp.getJson('/v1/mobile/c2/cards')
        expect(status).toBe(503)
        expect(body).toEqual({ ok: false, code: 'home_unavailable' })
      },
      { hrcDownAtBoot: true }
    )
  })
})

describe('POST /v1/mobile/c2/actions', () => {
  test('reply sends the exact text once with both fences and records receipt, card and ledger', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card)
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.outcome).toBe('sent')
      expect(body.requestId).toBe(request.requestId)
      expect(body.replayed).toBe(false)
      expect(body.receipt).toEqual({
        node: NODE,
        sessionRef: SEAT_REF,
        hostSessionId: 'hsid-c2fixture-acp',
        generation: 2,
        runtimeId: 'rt-c2fixture-acp',
        runId: 'run-fake-1',
      })
      expect(typeof body.ledger?.hrcSeq).toBe('number')

      const sends = seatSends(acp)
      expect(sends).toHaveLength(1)
      expect(sends[0]?.body).toMatchObject({
        selector: { sessionRef: SEAT_REF },
        text: REPLY_TEXT,
        enter: true,
        fences: { expectedHostSessionId: 'hsid-c2fixture-acp', expectedGeneration: 2 },
      })

      const receipt = acp.fake.find(SEAT, 'receipt', request.requestId, 2)
      expect(receipt?.ns).toBe('c2')
      expect(receipt?.body['stage']).toBe('done')
      expect(receipt?.body['receipt']).toMatchObject({
        runId: 'run-fake-1',
        hostSessionId: 'hsid-c2fixture-acp',
      })
      // The receipt was created create-only by the phone principal, before the send.
      const receiptCreate = acp.fake.calls.find(
        (call) =>
          call.method === 'PUT' &&
          (call.body as { kind?: string; id?: string }).kind === 'receipt' &&
          (call.body as { id?: string }).id === request.requestId
      )
      expect(receiptCreate?.principal).toBe('agent:lance')
      expect((receiptCreate?.body as { expect?: unknown }).expect).toMatchObject({
        updatedAt: null,
      })
      expect(receiptCreate?.at).toBeLessThanOrEqual(sends[0]?.at ?? 0)

      const stored = acp.card()
      expect(stored.body['state']).toBe('sent')
      expect(stored.body['runId']).toBe('run-fake-1')
      expect(stored.body['sentText']).toBe(REPLY_TEXT)
      expect(stored.body['pending'] ?? null).toBeNull()

      const acts = acp.fake.ledger.filter(
        (event) => event.eventKind === 'session.annotation.action'
      )
      expect(acts).toHaveLength(1)
      expect(acts[0]?.payload).toMatchObject({
        kind: 'card',
        id: ATTENTION_AT,
        action: request.actionId,
        attributes: {
          kind: 'reply',
          recommended: true,
          edited: false,
          ok: true,
          requestId: request.requestId,
        },
        principal: 'agent:lance',
      })
    })
  })

  test('a replay answers the recorded outcome and identical receipt without a second send', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card)
      const first = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      const replay = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(replay.status).toBe(200)
      expect(replay.body.replayed).toBe(true)
      expect(replay.body.outcome).toBe(first.body.outcome)
      expect(replay.body.receipt).toEqual(first.body.receipt)
      expect(seatSends(acp)).toHaveLength(1)
    })
  })

  test('the same requestId with another payload is request_mismatch and executes nothing', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card)
      await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      const receiptBefore = structuredClone(acp.fake.find(SEAT, 'receipt', request.requestId, 2))
      const changed = { ...request, text: `${REPLY_TEXT} changed`, edited: true }
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', changed)
      expect(status).toBe(200)
      expect(body.ok).toBe(false)
      expect(body.outcome).toBe('request_mismatch')
      expect(seatSends(acp)).toHaveLength(1)
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, 2)).toEqual(receiptBefore)
    })
  })

  test('two clients racing one card: exactly one send, the other card_not_open', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const a = replyRequest(card)
      const b = replyRequest(card)
      const results = await Promise.all([
        acp.postJson<ActionResponse>('/v1/mobile/c2/actions', a),
        acp.postJson<ActionResponse>('/v1/mobile/c2/actions', b),
      ])
      const outcomes = results.map((result) => result.body.outcome).sort()
      expect(outcomes).toEqual(['card_not_open', 'sent'])
      expect(seatSends(acp)).toHaveLength(1)
      const okActs = acp.fake.ledger.filter(
        (event) =>
          event.eventKind === 'session.annotation.action' &&
          (event.payload['attributes'] as { ok?: boolean }).ok === true
      )
      expect(okActs).toHaveLength(1)
    })
  })

  test('a stale expectUpdatedAt is card_not_open, recorded done, with no send', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      acp.fake.put({
        scopeRef: SEAT,
        generation: 2,
        kind: 'card',
        id: ATTENTION_AT,
        body: { ...acp.card().body, title: 'Revised by Vesta' },
      })
      const request = replyRequest(card)
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(status).toBe(200)
      expect(body.outcome).toBe('card_not_open')
      expect(body.card?.updatedAt).toBe(acp.card().updatedAt)
      expect(seatSends(acp)).toHaveLength(0)
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, 2)?.body['stage']).toBe('done')
      const readback = await acp.getJson<ActionResponse>(
        reconcilePath(request.requestId, request.key)
      )
      expect(readback.body.outcome).toBe('card_not_open')
    })
  })

  test('the server derives edited from the declared text, not the phone claim', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      // Claims unedited while sending other text: c2-core records what it sees.
      const request = replyRequest(card, { text: 'Ship it, but tag it first.', edited: false })
      const { body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(body.outcome).toBe('sent')
      expect(seatSends(acp)).toHaveLength(1)
      expect((seatSends(acp)[0]?.body as { text?: string }).text).toBe('Ship it, but tag it first.')
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, 2)?.body['edited']).toBe(true)
      const act = acp.fake.ledger.find((event) => event.eventKind === 'session.annotation.action')
      expect((act?.payload['attributes'] as { edited?: boolean }).edited).toBe(true)
    })
  })

  test('empty reply text is invalid_text with no send', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card, { text: '   ', edited: true })
      const { body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(body.outcome).toBe('invalid_text')
      expect(seatSends(acp)).toHaveLength(0)
    })
  })

  test('jump returns local navigation identity, records the act, and sends nothing', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const jump = card.actions.find((action) => action.kind === 'jump')
      const request = {
        requestId: newRequestId(),
        key: card.key,
        expectUpdatedAt: card.updatedAt,
        actionId: jump?.id,
        kind: 'jump',
        recommended: false,
        edited: false,
      }
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(status).toBe(200)
      expect(body.outcome).toBe('opened')
      expect(body.open).toEqual({
        node: NODE,
        sessionRef: SEAT_REF,
        hostSessionId: 'hsid-c2fixture-acp',
        generation: 2,
      })
      expect(seatSends(acp)).toHaveLength(0)
      expect(
        acp.fake.ledger.filter((event) => event.eventKind === 'session.annotation.action')
      ).toHaveLength(1)
    })
  })

  test('a malformed body is 400', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      expect((await acp.post('/v1/mobile/c2/actions', '{not json')).status).toBe(400)
      const { requestId: _drop, ...noRequestId } = replyRequest(card)
      expect((await acp.post('/v1/mobile/c2/actions', noRequestId)).status).toBe(400)
      expect(
        (await acp.post('/v1/mobile/c2/actions', replyRequest(card, { kind: 'detonate' }))).status
      ).toBe(400)
      expect(acp.fake.writes()).toHaveLength(0)
    })
  })
})

describe('GET /v1/mobile/c2/actions/:requestId', () => {
  test('reads the receipt back without any write, claim or send', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const request = replyRequest(card)
      const first = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      await settle() // let the best-effort acted line land first
      const writesBefore = acp.fake.writes().length
      const annotationsBefore = structuredClone(acp.fake.annotations)
      for (let i = 0; i < 3; i += 1) {
        const { status, body } = await acp.getJson<ActionResponse>(
          reconcilePath(request.requestId, request.key)
        )
        expect(status).toBe(200)
        expect(body.requestId).toBe(request.requestId)
        expect(body.outcome).toBe(first.body.outcome)
        expect(body.receipt).toEqual(first.body.receipt)
      }
      await settle()
      expect(acp.fake.writes()).toHaveLength(writesBefore)
      expect(acp.fake.annotations).toEqual(annotationsBefore)
      expect(seatSends(acp)).toHaveLength(1)
    })
  })

  test('an absent receipt is unknown_outcome with reason receipt_missing', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const { status, body } = await acp.getJson<ActionResponse>(
        reconcilePath(newRequestId(), card.key)
      )
      expect(status).toBe(200)
      expect(body.ok).toBe(false)
      expect(body.outcome).toBe('unknown_outcome')
      expect(body.reason).toBe('receipt_missing')
      expect(acp.fake.writes()).toHaveLength(0)
    })
  })

  test('the dedup scope is required: missing sessionRef or generation is 400', async () => {
    await withC2Acp(async (acp) => {
      const id = newRequestId()
      expect((await acp.get(`/v1/mobile/c2/actions/${id}?generation=2`)).status).toBe(400)
      expect(
        (await acp.get(`/v1/mobile/c2/actions/${id}?sessionRef=${encodeURIComponent(SEAT_REF)}`))
          .status
      ).toBe(400)
    })
  })
})

describe('the existing mobile gate covers /v1/mobile/c2/* unchanged', () => {
  test('enforcing: a tokenless tailnet peer is 401, a paired bearer reaches the snapshot', async () => {
    const store = createMobileAuthStore()
    const redeemed = store.redeemPairingCode(store.mintPairingCode().code, 'c2-reds')
    if (redeemed === undefined) throw new Error('fixture pairing failed')
    store.setEnforce(true)
    await withC2Acp(
      async (acp) => {
        const handlers = createAcpListenerHandlers({
          acpServer: acp.wired.server,
          deps: resolveAcpServerDeps(acp.wired.deps),
          handleCapRpc: async () => Response.json({}),
        })
        const tailnet = {
          requestIP: () => ({ address: '100.118.130.15', family: 'IPv4', port: 50000 }),
          upgrade: () => false,
        }
        const call = (headers: Record<string, string>) =>
          handlers.fetch(
            new Request('http://max3.tail53cc3b.ts.net:18470/v1/mobile/c2/cards', { headers }),
            tailnet
          )
        const denied = await call({})
        expect(denied?.status).toBe(401)
        expect(await denied?.json()).toEqual({ ok: false, code: 'unauthorized' })
        const allowed = await call({ authorization: `Bearer ${redeemed.token}` })
        expect(allowed?.status).toBe(200)
        expect(((await allowed?.json()) as Snapshot).ok).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })
})
