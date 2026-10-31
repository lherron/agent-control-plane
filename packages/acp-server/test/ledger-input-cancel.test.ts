import { describe, expect, test } from 'bun:test'

import type { WorkClient } from '@wrkq/client'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

/*
 * T-12177 B: POST /v1/interface/ledger-inputs/:envelopeId/cancel.
 *
 * Ways this can fail, each pinned below:
 *  - the (gateway, room) has no recorded ledger route → 404, nothing touched
 *  - acting as the wrong principal (must be the route's humanPrincipalRef)
 *  - a pending input is interrupted instead of withdrawn
 *  - a withdraw that loses the race to presentation is reported as withdrawn
 *  - a presented input is interrupted without the receipt's node/inputId,
 *    so a peer seat or a later turn is hit (incl. a launch-carried receipt
 *    with no inputId: refused, never an unguarded interrupt)
 *  - the obligation is left open, so the interrupted turn is re-driven
 *  - ack fails but the interrupt still fires
 *  - HRC skip warnings or errors (peer down) surface as success, or throw
 *  - a terminal envelope triggers any side effect
 */

const GATEWAY = 'acp-discord-smoke'
const ROOM_UUID = 'room-uuid-1'
const ENVELOPE = 'EN-500'
const HUMAN = 'agent:lance'

type Receipt = {
  memberRef: string
  node?: string
  runtimeId?: string
  inputId?: string
  presentedAt: string
}

type EnvelopeState = {
  state: string
  terminal: boolean
  presentedTo: Receipt[]
}

const PRESENTED: Receipt = {
  memberRef: 'smokey@agent-control-plane:minisvc',
  node: 'svc',
  runtimeId: 'rt-svc-1',
  inputId: 'submission_inv-1_1',
  presentedAt: '2026-10-31T17:31:49Z',
}

function ledgerDouble(initial: EnvelopeState[], options: { ackFails?: boolean } = {}) {
  const calls: unknown[] = []
  const principals: string[] = []
  const reads = [...initial]
  const current = () =>
    reads.length > 1 ? (reads.shift() as EnvelopeState) : (reads[0] as EnvelopeState)
  const envelope = (view: EnvelopeState) => ({
    id: ENVELOPE,
    roomUuid: ROOM_UUID,
    obligation: 'reply_required',
    ...view,
  })
  const client = {
    wrkq: {
      envelope: {
        show: async (params: { envelope: string; principalRef?: string }) => {
          calls.push({ op: 'show', envelope: params.envelope })
          return envelope(current())
        },
        withdraw: async (params: { envelope: string; reason?: string }) => {
          calls.push({ op: 'withdraw', envelope: params.envelope, reason: params.reason })
          const view = current()
          return view.state === 'pending'
            ? {
                withdrawn: [envelope({ ...view, state: 'withdrawn', terminal: true })],
                refused: [],
              }
            : {
                withdrawn: [],
                refused: [{ envelopeId: ENVELOPE, reason: 'already_presented', state: view.state }],
              }
        },
        ack: async (params: { envelopes: string[]; note?: string }) => {
          calls.push({ op: 'ack', envelopes: params.envelopes, note: params.note })
          if (options.ackFails) throw new Error('ack refused: not an operator')
          return { items: [] }
        },
      },
    },
  } as unknown as WorkClient
  return {
    calls,
    principals,
    workClientForPrincipal: async (principalRef: string) => {
      principals.push(principalRef)
      return client
    },
  }
}

function hrcDouble(
  calls: unknown[],
  respond: () => Promise<Awaited<ReturnType<AcpHrcClient['interrupt']>>>
): AcpHrcClient {
  return {
    interrupt: async (runtimeId: string, options?: unknown) => {
      calls.push({ op: 'interrupt', runtimeId, options })
      return respond()
    },
  } as unknown as AcpHrcClient
}

async function cancel(fixture: Parameters<Parameters<typeof withWiredServer>[0]>[0]) {
  const response = await fixture.request({
    method: 'POST',
    path: `/v1/interface/ledger-inputs/${ENVELOPE}/cancel`,
    body: { gatewayId: GATEWAY, roomUuid: ROOM_UUID, actorRef: 'discord:user:42' },
  })
  return { status: response.status, body: await fixture.json<Record<string, unknown>>(response) }
}

function recordRoute(fixture: Parameters<Parameters<typeof withWiredServer>[0]>[0]) {
  fixture.interfaceStore.discordLedgerProjection.recordRoute({
    gatewayId: GATEWAY,
    roomUuid: ROOM_UUID,
    roomKey: 'R-00567',
    bindingId: 'ifb_test',
    conversationRef: 'channel:1',
    humanPrincipalRef: HUMAN,
  })
}

const ok = async () => ({ ok: true as const, hostSessionId: 'hsid-1', runtimeId: 'rt-svc-1' })

describe('POST /v1/interface/ledger-inputs/:envelopeId/cancel', () => {
  test('presented input: acks the obligation, then interrupts the receipt turn on its node, as the route principal', async () => {
    const ledger = ledgerDouble([{ state: 'presented', terminal: false, presentedTo: [PRESENTED] }])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.status).toBe(200)
        expect(result.body).toEqual({
          outcome: 'interrupted',
          node: 'svc',
          runtimeId: 'rt-svc-1',
        })
        expect(ledger.principals).toEqual([HUMAN])
        expect(ledger.calls).toEqual([
          { op: 'show', envelope: ENVELOPE },
          {
            op: 'ack',
            envelopes: [ENVELOPE],
            note: 'cancelled from Discord by discord:user:42',
          },
          {
            op: 'interrupt',
            runtimeId: 'rt-svc-1',
            options: { node: 'svc', inputId: 'submission_inv-1_1' },
          },
        ])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('pending input: withdraws it and never interrupts', async () => {
    const ledger = ledgerDouble([{ state: 'pending', terminal: false, presentedTo: [] }])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body).toEqual({ outcome: 'withdrawn' })
        expect(ledger.calls).toEqual([
          { op: 'show', envelope: ENVELOPE },
          { op: 'withdraw', envelope: ENVELOPE, reason: 'cancelled from Discord' },
        ])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('withdraw that loses the race to presentation falls through to the presented path', async () => {
    const ledger = ledgerDouble([
      { state: 'pending', terminal: false, presentedTo: [] },
      { state: 'presented', terminal: false, presentedTo: [PRESENTED] },
    ])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body).toEqual({ outcome: 'interrupted', node: 'svc', runtimeId: 'rt-svc-1' })
        expect(ledger.calls.map((call) => (call as { op: string }).op)).toEqual([
          'show',
          'withdraw',
          'show',
          'ack',
          'interrupt',
        ])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('HRC skip warning (late ❌, input no longer active) is not_applied, not success', async () => {
    const ledger = ledgerDouble([{ state: 'presented', terminal: false, presentedTo: [PRESENTED] }])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.status).toBe(200)
        expect(result.body).toEqual({
          outcome: 'not_applied',
          reason: 'turn_already_finished: input is not in the executing turn; interrupt skipped',
          node: 'svc',
          runtimeId: 'rt-svc-1',
        })
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, async () => ({
          ...(await ok()),
          warning: 'input is not in the executing turn; interrupt skipped',
        })),
      }
    )
  })

  test('HRC error (peer down) is not_applied with the reason, never a 5xx', async () => {
    const ledger = ledgerDouble([{ state: 'presented', terminal: false, presentedTo: [PRESENTED] }])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.status).toBe(200)
        expect(result.body['outcome']).toBe('not_applied')
        expect(String(result.body['reason'])).toContain('could not reach svc over federation')
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, async () => {
          throw new Error('runtime_unavailable: could not reach svc over federation')
        }),
      }
    )
  })

  test('ack failure stops before the interrupt', async () => {
    const ledger = ledgerDouble(
      [{ state: 'presented', terminal: false, presentedTo: [PRESENTED] }],
      {
        ackFails: true,
      }
    )
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body['outcome']).toBe('not_applied')
        expect(String(result.body['reason'])).toContain('ack_failed')
        expect(ledger.calls.some((call) => (call as { op: string }).op === 'interrupt')).toBe(false)
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('receipt without a runtime is not_applied and touches nothing', async () => {
    const ledger = ledgerDouble([
      {
        state: 'presented',
        terminal: false,
        presentedTo: [{ memberRef: PRESENTED.memberRef, presentedAt: PRESENTED.presentedAt }],
      },
    ])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body).toEqual({ outcome: 'not_applied', reason: 'no_runtime_on_receipt' })
        expect(ledger.calls).toEqual([{ op: 'show', envelope: ENVELOPE }])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('receipt without an inputId (launch-carried) never sends an unguarded interrupt', async () => {
    const ledger = ledgerDouble([
      {
        state: 'presented',
        terminal: false,
        presentedTo: [
          {
            memberRef: PRESENTED.memberRef,
            node: 'svc',
            runtimeId: 'rt-svc-1',
            presentedAt: PRESENTED.presentedAt,
          },
        ],
      },
    ])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body).toEqual({
          outcome: 'not_applied',
          reason: 'no_input_on_receipt',
          node: 'svc',
          runtimeId: 'rt-svc-1',
        })
        expect(ledger.calls).toEqual([{ op: 'show', envelope: ENVELOPE }])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('terminal envelope is not_applied and touches nothing', async () => {
    const ledger = ledgerDouble([{ state: 'acked', terminal: true, presentedTo: [PRESENTED] }])
    await withWiredServer(
      async (fixture) => {
        recordRoute(fixture)
        const result = await cancel(fixture)
        expect(result.body).toEqual({ outcome: 'not_applied', reason: 'already_finished' })
        expect(ledger.calls).toEqual([{ op: 'show', envelope: ENVELOPE }])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })

  test('unknown ledger route is 404 and reads nothing', async () => {
    const ledger = ledgerDouble([{ state: 'presented', terminal: false, presentedTo: [PRESENTED] }])
    await withWiredServer(
      async (fixture) => {
        const result = await cancel(fixture)
        expect(result.status).toBe(404)
        expect(ledger.calls).toEqual([])
        expect(ledger.principals).toEqual([])
      },
      {
        workClientForPrincipal: ledger.workClientForPrincipal,
        hrcClient: hrcDouble(ledger.calls, ok),
      }
    )
  })
})
