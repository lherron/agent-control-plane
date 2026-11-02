/**
 * The mobile wire v2 on an ephemeral ACP (card contract rev 4.1 §12, T-12239):
 * `/v1/mobile/c2/v2/{snapshot,actions,actions/:requestId,artifacts/:id}`, and the
 * v1 card routes answering 410 so an old phone build fails closed.
 */
import { describe, expect, test } from 'bun:test'

import { createAcpListenerHandlers } from '../../src/acp-listener.js'
import { resolveAcpServerDeps } from '../../src/deps.js'
import { createMobileAuthStore } from '../../src/mobile-auth/store.js'

import {
  ACTIONS,
  ANSWER_TEXT,
  ASK,
  type ActionResponse,
  NODE,
  SEAT,
  SEAT_REF,
  SNAPSHOT,
  type Snapshot,
  VESTA,
  answerRequest,
  asksBody,
  newRequestId,
  reconcilePath,
  seatSends,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

const writesOf = (acp: Parameters<Parameters<typeof withC2Acp>[0]>[0]) => acp.fake.writes().length

describe('§12.1 v1 routes fail closed', () => {
  test('every v1 card route answers 410 wire_version_unsupported and writes nothing', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const before = writesOf(acp)
      const gone = { ok: false, code: 'wire_version_unsupported', wire: 2 }
      const cards = await acp.get('/v1/mobile/c2/cards')
      expect(cards.status).toBe(410)
      expect(await cards.json()).toEqual(gone)
      const post = await acp.post('/v1/mobile/c2/actions', {
        requestId: newRequestId(),
        key: {
          sessionRef: SEAT_REF,
          subject: 'generation',
          generation: 2,
          ns: 'c2',
          kind: 'card',
          id: 'x',
        },
        expectUpdatedAt: entry.expectUpdatedAt,
        actionId: 'ship',
        kind: 'reply',
        text: 'Ship it',
        recommended: true,
        edited: false,
      })
      expect(post.status).toBe(410)
      expect(await post.json()).toEqual(gone)
      expect((await acp.get('/v1/mobile/c2/actions/x?sessionRef=s&generation=1')).status).toBe(410)
      expect((await acp.get('/v1/mobile/c2/artifacts/x')).status).toBe(410)
      await settle(200)
      expect(writesOf(acp)).toBe(before)
      expect(seatSends(acp)).toHaveLength(0)
    })
  })
})

describe('GET /v1/mobile/c2/v2/snapshot', () => {
  test('wire 2 with the seat entry, its row, server-side actions and capabilities', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot, entry } = await snapshotEntry(acp)
      expect(snapshot).toMatchObject({
        ok: true,
        wire: 2,
        home: { node: NODE, reachable: true, stale: false },
      })
      expect(snapshot.capabilities.actions).toEqual([
        'answer',
        'compose',
        'jump',
        'delegate',
        'rotate',
        'elucidate',
        'release',
        'snooze',
      ])
      expect(snapshot.counts).toEqual({ openRows: 1, openEntries: 1 })
      expect(entry.key).toEqual({
        sessionRef: SEAT_REF,
        subject: 'seat',
        ns: 'hrc',
        kind: 'asks',
        id: 'open',
      })
      expect(entry.expectUpdatedAt).toBe(acp.record().updatedAt)
      expect(entry.record?.updatedBy).toBe('agent:smokey')
      expect(entry.seat).toMatchObject({ scopeRef: SEAT, online: true, generation: 2 })
      expect(entry.attention).toMatchObject({ state: 'blocking', excerpt: 'Ship the fixture?' })
      const row = entry.rows[0]!
      expect(row).toMatchObject({
        id: 'ship',
        displayId: `${SEAT}#ship`,
        ask: ASK,
        state: 'open',
        preselect: 'Ship',
        reviewAlternative: null,
      })
      expect(row.options).toEqual([
        { label: 'Ship', text: 'Ship' },
        { label: 'Hold', text: 'Hold until Monday' },
      ])
      expect(row.detail.status).toBe('ready')
      expect(row.detail.artifact).toBeString()
      expect(JSON.stringify(snapshot)).not.toContain(acp.htmlPath)
      expect(row.actions).toEqual([
        {
          id: 'elucidate:ship',
          kind: 'elucidate',
          label: 'Elucidate',
          text: `[c2] elucidate ${SEAT}#ship`,
        },
      ])
      expect(entry.actions.map((a) => a.id)).toEqual([
        'answers',
        'compose',
        'jump',
        'delegate',
        'rotate',
      ])
      expect(entry.actions.find((a) => a.kind === 'rotate')?.text).toBe(
        `[c2] rotate ${SEAT} (Lance)`
      )
    })
  })

  test('an absent scope row allows nothing', async () => {
    await withC2Acp(
      async (acp) => {
        const { status, body } = await acp.getJson<Snapshot>(SNAPSHOT)
        expect(status).toBe(200)
        expect(body.entries.some((e) => e.seat.scopeRef === SEAT)).toBe(false)
        expect(body.counts.openRows).toBe(0)
      },
      { noScope: true }
    )
  })

  test('a bounded long poll answers unchanged at its deadline; a record change wakes it early', async () => {
    await withC2Acp(
      async (acp) => {
        const { snapshot } = await snapshotEntry(acp)
        const quiet = await acp.getJson<Snapshot>(
          `${SNAPSHOT}?after=${encodeURIComponent(snapshot.revision)}&waitMs=400`
        )
        expect(quiet.body).toEqual({
          ok: true,
          unchanged: true,
          revision: snapshot.revision,
        } as never)
        const started = Date.now()
        const pending = acp.getJson<Snapshot>(
          `${SNAPSHOT}?after=${encodeURIComponent(snapshot.revision)}&waitMs=20000`
        )
        await settle(200)
        acp.fake.put({
          scopeRef: SEAT,
          subject: 'seat',
          ns: 'hrc',
          kind: 'asks',
          id: 'open',
          body: asksBody({ ask: 'Ship it now?' }),
          by: 'agent:smokey',
        })
        const { body } = await pending
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(body.revision).not.toBe(snapshot.revision)
        expect(body.entries.find((e) => e.seat.scopeRef === SEAT)?.rows[0]?.ask).toBe(
          'Ship it now?'
        )
      },
      { config: { pollMs: 50 } }
    )
  })

  test('waitMs above 25000 is malformed', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot } = await snapshotEntry(acp)
      expect(
        (await acp.get(`${SNAPSHOT}?after=${encodeURIComponent(snapshot.revision)}&waitMs=25001`))
          .status
      ).toBe(400)
    })
  })

  test('with HRC gone it serves the last snapshot marked stale, and an action is not_submitted', async () => {
    await withC2Acp(async (acp) => {
      const { snapshot, entry } = await snapshotEntry(acp)
      await acp.fake.stop()
      await settle(300)
      const { status, body } = await acp.getJson<Snapshot>(SNAPSHOT)
      expect(status).toBe(200)
      expect(body.home).toMatchObject({ node: NODE, reachable: false, stale: true })
      expect(body.revision).toBe(snapshot.revision)
      const action = await acp.post(ACTIONS, answerRequest(entry))
      expect([200, 503]).toContain(action.status)
      expect(((await action.json()) as ActionResponse).ok).toBe(false)
    })
  })

  test('with no prior snapshot and HRC gone it answers 503 home_unavailable', async () => {
    await withC2Acp(
      async (acp) => {
        const { status, body } = await acp.getJson(SNAPSHOT)
        expect(status).toBe(503)
        expect(body).toEqual({ ok: false, code: 'home_unavailable' })
      },
      { hrcDownAtBoot: true }
    )
  })
})

describe('POST /v1/mobile/c2/v2/actions', () => {
  test('answer: one fenced send with the question, sent on the row, delivered claim, per-row ledger act', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const request = answerRequest(entry)
      const { status, body } = await acp.postJson<ActionResponse>(ACTIONS, request)
      expect(status).toBe(200)
      expect(body).toMatchObject({
        ok: true,
        outcome: 'sent',
        requestId: request.requestId,
        replayed: false,
      })
      expect(body.receipt).toMatchObject({ node: NODE, sessionRef: SEAT_REF, generation: 2 })
      expect(body.ledger?.hrcSeq).toBeNumber()
      expect(body.entry?.rows[0]?.state).toBe('sent')
      const sends = seatSends(acp)
      expect(sends).toHaveLength(1)
      expect(sends[0]?.body).toMatchObject({
        text: ANSWER_TEXT,
        enter: true,
        fences: { expectedHostSessionId: 'hsid-c2fixture-acp', expectedGeneration: 2 },
      })
      const sent = (acp.record().body as { questions: Array<{ sent?: Record<string, unknown> }> })
        .questions[0]?.sent
      expect(sent).toMatchObject({
        by: 'agent:lance',
        text: ANSWER_TEXT,
        runId: body.receipt?.runId,
      })
      expect(acp.record().updatedBy).toBe('system:c2-controller')
      const claim = acp.fake.find(SEAT, 'receipt', 'answer:ship', null)
      expect(claim?.body).toMatchObject({
        requestId: request.requestId,
        rowId: 'ship',
        outcome: 'delivered',
      })
      const receipt = acp.fake.find(SEAT, 'receipt', request.requestId, null)
      expect(receipt?.body).toMatchObject({ v: 2, stage: 'done', result: { outcome: 'sent' } })
      const acts = acp.fake.ledger.filter((e) => e.eventKind === 'session.annotation.action')
      expect(acts).toHaveLength(1)
      expect(acts[0]?.payload).toMatchObject({ kind: 'asks', id: 'open', action: 'answered' })
    })
  })

  test('a replay answers the recorded outcome without a second send; another payload is request_mismatch', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const request = answerRequest(entry)
      const first = await acp.postJson<ActionResponse>(ACTIONS, request)
      const again = await acp.postJson<ActionResponse>(ACTIONS, request)
      expect(again.body).toMatchObject({ outcome: 'sent', replayed: true })
      expect(again.body.receipt).toEqual(first.body.receipt)
      const other = await acp.postJson<ActionResponse>(ACTIONS, {
        ...request,
        text: 'something else',
      })
      expect(other.body.outcome).toBe('request_mismatch')
      expect(seatSends(acp)).toHaveLength(1)
    })
  })

  test('two clients racing one row: exactly one send, the other card_not_open', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const [a, b] = await Promise.all([
        acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry)),
        acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry)),
      ])
      expect([a.body.outcome, b.body.outcome].sort()).toEqual(['card_not_open', 'sent'])
      expect(seatSends(acp)).toHaveLength(1)
    })
  })

  test('a stale expectUpdatedAt is card_not_open with no send', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      acp.fake.put({
        scopeRef: SEAT,
        subject: 'seat',
        ns: 'hrc',
        kind: 'asks',
        id: 'open',
        body: asksBody({ why: 'changed' }),
        by: 'agent:smokey',
      })
      await settle(200)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('card_not_open')
      expect(seatSends(acp)).toHaveLength(0)
    })
  })

  test('the server derives edited from the assembled text, not the phone claim; the stamp is what was sent', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const text = `1. ${ASK} — Ship after 5pm.`
      await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry, { text, edited: false }))
      const acts = acp.fake.ledger.filter((e) => e.eventKind === 'session.annotation.action')
      expect((acts[0]?.payload as { attributes?: { edited?: boolean } }).attributes?.edited).toBe(
        true
      )
      expect(
        (acp.record().body as { questions: Array<{ sent?: { text: string } }> }).questions[0]?.sent
          ?.text
      ).toBe(text)
    })
  })

  test('empty text is invalid_text; an answer for no open row is invalid_action; neither sends', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      expect(
        (await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry, { text: '  ' }))).body
          .outcome
      ).toBe('invalid_text')
      expect(
        (
          await acp.postJson<ActionResponse>(
            ACTIONS,
            answerRequest(entry, { answers: [{ id: 'ship', later: true }] })
          )
        ).body.outcome
      ).toBe('invalid_action')
      expect(seatSends(acp)).toHaveLength(0)
    })
  })

  test('jump returns the seat identity, records the act, and sends nothing', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, {
        requestId: newRequestId(),
        key: entry.key,
        expectUpdatedAt: entry.expectUpdatedAt,
        actionId: 'jump',
        kind: 'jump',
        recommended: false,
        edited: false,
      })
      expect(body).toMatchObject({
        ok: true,
        outcome: 'opened',
        open: {
          node: NODE,
          sessionRef: SEAT_REF,
          hostSessionId: 'hsid-c2fixture-acp',
          generation: 2,
        },
      })
      expect(seatSends(acp)).toHaveLength(0)
    })
  })

  test('elucidate reaches Vesta with the exact line; the row shows pending', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, {
        requestId: newRequestId(),
        key: entry.key,
        expectUpdatedAt: entry.expectUpdatedAt,
        actionId: 'elucidate:ship',
        kind: 'elucidate',
        rowId: 'ship',
        recommended: false,
        edited: false,
      })
      expect(body.outcome).toBe('requested')
      const toVesta = acp.fake
        .literalInputs()
        .filter(
          (c) =>
            (c.body as { selector?: { sessionRef?: string } }).selector?.sessionRef ===
            `${VESTA}/lane:main`
        )
      expect(toVesta.map((c) => (c.body as { text: string }).text)).toEqual([
        `[c2] elucidate ${SEAT}#ship`,
      ])
      expect(body.entry?.rows[0]?.detail.status).toBe('pending')
    })
  })

  test('a malformed body is 400 invalid_request', async () => {
    await withC2Acp(async (acp) => {
      const response = await acp.post(ACTIONS, '{not json')
      expect(response.status).toBe(400)
      const missing = await acp.postJson(ACTIONS, { requestId: 'x' })
      expect(missing.status).toBe(400)
      expect(missing.body).toMatchObject({ ok: false, code: 'invalid_request' })
    })
  })
})

describe('GET /v1/mobile/c2/v2/actions/:requestId', () => {
  test('reads the receipt back without any write or send; absent is receipt_missing; sessionRef is required', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const request = answerRequest(entry)
      await acp.postJson(ACTIONS, request)
      await settle(300) // the acted line to Vesta goes out after the response
      const writes = writesOf(acp)
      const { status, body } = await acp.getJson<ActionResponse>(
        reconcilePath(request.requestId, SEAT_REF)
      )
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true, outcome: 'sent', replayed: true })
      expect(writesOf(acp)).toBe(writes)
      const missing = await acp.getJson<ActionResponse>(reconcilePath('nope', SEAT_REF))
      expect(missing.body).toMatchObject({
        ok: false,
        outcome: 'unknown_outcome',
        reason: 'receipt_missing',
      })
      expect((await acp.get(`/v1/mobile/c2/v2/actions/${request.requestId}`)).status).toBe(400)
    })
  })
})

describe('the existing mobile gate covers /v1/mobile/c2/v2/* unchanged', () => {
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
            new Request(`http://max3.tail53cc3b.ts.net:18470${SNAPSHOT}`, { headers }),
            tailnet
          )
        const denied = await call({})
        expect(denied?.status).toBe(401)
        const allowed = await call({ authorization: `Bearer ${redeemed.token}` })
        expect(allowed?.status).toBe(200)
        expect(((await allowed?.json()) as Snapshot).wire).toBe(2)
      },
      { mobileAuthStore: store }
    )
  })
})
