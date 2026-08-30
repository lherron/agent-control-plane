import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type { HrcLifecycleEvent, HrcMessageRecord, HrcSessionRecord } from 'hrc-core'
import type { CollaborationLedger, CollaborationMessage, CollaborationSayInput } from 'wrkq-lib'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import type { MobileWebSocketLike } from '../src/handlers/mobile-ws.js'
import { openMobileWebSocket } from '../src/handlers/mobile.js'
import { withWiredServer } from './fixtures/wired-server.js'

const SESSION_REF = 'agent:cody:project:agent-control-plane:task:T-07614/lane:main'
const MEMBER_REF = 'cody@agent-control-plane:T-07614'
const HOST_SESSION_ID = 'hsid-mobile-collaboration'

function hrcMessage(messageId = 'msg-legacy'): HrcMessageRecord {
  return {
    messageSeq: 4,
    messageId,
    createdAt: '2026-08-27T17:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: SESSION_REF },
    rootMessageId: messageId,
    body: 'ledger-backed mobile prompt',
    bodyFormat: 'text/plain',
    execution: { state: 'accepted', sessionRef: SESSION_REF },
  }
}

function ledgerMessage(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    messageId: 'EN-00005',
    messageSeq: 5,
    roomKey: 'T-07614',
    groupId: 'EN-00005',
    sender: { principalRef: 'agent:lance' },
    recipient: { principalRef: 'agent:cody', scopeRef: MEMBER_REF },
    obligation: 'reply_required',
    state: 'pending',
    body: 'ledger-backed mobile prompt',
    taskId: 'T-07614',
    createdAt: '2026-08-27T17:00:01.000Z',
    updatedAt: '2026-08-27T17:00:01.000Z',
    ...overrides,
  }
}

function ledger(input: {
  messages?: CollaborationMessage[]
  sayCalls?: CollaborationSayInput[]
}): CollaborationLedger {
  return {
    async pageMessagesByMember(pageInput) {
      const all = input.messages ?? []
      const filtered = all.filter(
        (message) =>
          (pageInput.beforeMessageSeq === undefined ||
            message.messageSeq < pageInput.beforeMessageSeq) &&
          (pageInput.afterMessageSeq === undefined ||
            message.messageSeq > pageInput.afterMessageSeq)
      )
      const messages =
        pageInput.afterMessageSeq === undefined
          ? filtered.slice(-pageInput.limit)
          : filtered.slice(0, pageInput.limit)
      return {
        ledgerIncarnationId: 'wrkq-test-ledger',
        headMessageSeq: all.at(-1)?.messageSeq ?? 0,
        hasMoreBefore:
          pageInput.beforeMessageSeq !== undefined && filtered.length > messages.length,
        hasMoreAfter: pageInput.afterMessageSeq !== undefined && filtered.length > messages.length,
        messages,
      }
    },
    async listMessagesByMember() {
      return { messages: input.messages ?? [] }
    },
    async listMessagesByRoom() {
      return { messages: input.messages ?? [] }
    },
    async say(sayInput) {
      input.sayCalls?.push(sayInput)
      return { roomKey: sayInput.ref, groupId: 'EN-00006', envelopes: [] }
    },
  }
}

function hrcPrompt(
  hrcSeq: number,
  text: string,
  ts: string,
  overrides: Partial<HrcLifecycleEvent> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: 'agent:cody:project:agent-control-plane:task:T-07614',
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.user_prompt',
    replayed: false,
    payload: { text },
    ...overrides,
  }
}

function historyClient(events: HrcLifecycleEvent[]): AcpHrcClient {
  return {
    tailEvents: async (options) => {
      const matching = events.filter(
        (event) =>
          (options.hostSessionId === undefined || event.hostSessionId === options.hostSessionId) &&
          (options.generation === undefined || event.generation === options.generation) &&
          (options.beforeHrcSeq === undefined || event.hrcSeq < options.beforeHrcSeq)
      )
      const selected = matching.slice(-options.limit)
      return {
        events: selected,
        ledgerIncarnationId: 'hrc-test-ledger',
        headHrcSeq: events.at(-1)?.hrcSeq ?? 0,
        truncated: matching.length > selected.length,
      }
    },
    watch: () =>
      (async function* () {
        yield* events
      })(),
  } as unknown as AcpHrcClient
}

async function readHistory(input: {
  events: HrcLifecycleEvent[]
  messages: CollaborationMessage[]
}): Promise<{
  atoms: Array<{ payload: Record<string, unknown> }>
  frames: Array<{
    frameId: string
    frameKind: string
    lastHrcSeq: number
    lastMessageSeq?: number | undefined
    blocks: Array<{ text?: string | undefined; payload?: Record<string, unknown> | undefined }>
  }>
  newestCursor: { hrcSeq: number; messageSeq: number }
}> {
  return withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/mobile/history?sessionRef=${encodeURIComponent(SESSION_REF)}&hostSessionId=${HOST_SESSION_ID}&generation=1&limit=80`,
      })
      expect(response.status).toBe(200)
      return fixture.json(response)
    },
    { hrcClient: historyClient(input.events), collaborationLedger: ledger(input) }
  )
}

describe('mobile collaboration ledger', () => {
  test('history keeps the HRC prompt and carries collaboration identity and cursors onto it', async () => {
    const message = ledgerMessage()
    const hrcText = `[T-07614 · lance (gen 1) → you · reply required]\nhistory: wrkc log T-07614\n${message.body}`
    const history = await readHistory({
      events: [hrcPrompt(41, hrcText, '2026-08-27T17:00:02.000Z')],
      messages: [message],
    })

    expect(history.frames).toHaveLength(1)
    expect(history.frames[0]).toMatchObject({
      frameId: 'hrc-41',
      frameKind: 'user_prompt',
      lastHrcSeq: 41,
      lastMessageSeq: 5,
      blocks: [
        {
          text: hrcText,
          payload: { envelopeId: 'EN-00005', messageSeq: 5, roomKey: 'T-07614' },
        },
      ],
    })
    expect(history.newestCursor).toEqual({ hrcSeq: 41, messageSeq: 5 })
  })

  test('history retains a collaboration prompt that has no delivered HRC prompt', async () => {
    const history = await readHistory({ events: [], messages: [ledgerMessage()] })

    expect(history.frames).toHaveLength(1)
    expect(history.frames[0]).toMatchObject({
      frameId: 'msg-EN-00005',
      frameKind: 'user_prompt',
      lastHrcSeq: 0,
      lastMessageSeq: 5,
    })
    expect(JSON.stringify(history.atoms)).not.toContain('reply_required')
    expect(JSON.stringify(history.atoms)).not.toContain('pending')
    expect(history.frames[0]?.blocks[0]?.text).toBe('ledger-backed mobile prompt')
  })

  test('history matches repeated bodies one-to-one and retains both legitimate deliveries', async () => {
    const first = ledgerMessage()
    const second = ledgerMessage({
      messageId: 'EN-00006',
      messageSeq: 6,
      createdAt: '2026-08-27T17:00:10.000Z',
      updatedAt: '2026-08-27T17:00:10.000Z',
    })
    const history = await readHistory({
      events: [
        hrcPrompt(41, `kicker header\n${first.body}`, '2026-08-27T17:00:01.000Z'),
        hrcPrompt(42, `kicker header\n${second.body}`, '2026-08-27T17:00:11.000Z'),
      ],
      messages: [first, second],
    })

    expect(history.frames.map((frame) => frame.frameId)).toEqual(['hrc-41', 'hrc-42'])
    expect(history.frames.map((frame) => frame.lastMessageSeq)).toEqual([5, 6])
    expect(history.frames.map((frame) => frame.blocks[0]?.payload?.['envelopeId'])).toEqual([
      'EN-00005',
      'EN-00006',
    ])
  })

  test('live timeline merges a ledger message discovered alongside its HRC prompt', async () => {
    const message = ledgerMessage()
    const liveEvent = hrcPrompt(
      41,
      `kicker header\nhistory: wrkc log T-07614\n${message.body}`,
      '2026-08-27T17:00:02.000Z'
    )
    const session: HrcSessionRecord = {
      hostSessionId: HOST_SESSION_ID,
      scopeRef: 'agent:cody:project:agent-control-plane:task:T-07614',
      laneRef: 'main',
      generation: 1,
      status: 'ready',
      createdAt: '2026-08-27T16:00:00.000Z',
      updatedAt: '2026-08-27T17:00:00.000Z',
      ancestorScopeRefs: [],
    }
    let historyRead = true
    const collaboration = ledger({ messages: [message] })
    collaboration.pageMessagesByMember = async () => {
      if (historyRead) {
        historyRead = false
        return {
          ledgerIncarnationId: 'wrkq-test-ledger',
          headMessageSeq: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
          messages: [],
        }
      }
      return {
        ledgerIncarnationId: 'wrkq-test-ledger',
        headMessageSeq: message.messageSeq,
        hasMoreBefore: false,
        hasMoreAfter: false,
        messages: [message],
      }
    }
    const hrcClient = {
      listSessions: async () => [session],
      listRuntimes: async () => [],
      listLatestEventBySession: async () => [],
      getLatestRunForSession: async () => undefined,
      tailEvents: async () => ({
        events: [],
        ledgerIncarnationId: 'hrc-test-ledger',
        headHrcSeq: 0,
        truncated: false,
      }),
      watchBoundedEvents: () =>
        (async function* () {
          yield {
            type: 'ready' as const,
            ledgerIncarnationId: 'hrc-test-ledger',
            acceptedAfterHrcSeq: 0,
            replayHeadHrcSeq: 0,
          }
          yield {
            type: 'event' as const,
            ledgerIncarnationId: 'hrc-test-ledger',
            event: liveEvent,
          }
        })(),
    } as unknown as AcpHrcClient
    const sent: Array<Record<string, unknown>> = []
    const stateStore = openAcpStateStore({ dbPath: ':memory:' })
    const deps = {
      hrcClient,
      collaborationLedger: collaboration,
      stateStore,
    } as ResolvedAcpServerDeps
    const ws: MobileWebSocketLike = {
      data: {
        deps,
        url: `http://acp.test/v1/mobile/sessions/${HOST_SESSION_ID}/timeline`,
        kind: 'timeline',
        version: 1,
        hostSessionId: HOST_SESSION_ID,
        abortController: new AbortController(),
      },
      send(raw) {
        const envelope = JSON.parse(raw) as Record<string, unknown>
        sent.push(envelope)
        if (envelope['type'] === 'frame') this.data.abortController.abort()
        return raw.length
      },
      close() {},
    }

    try {
      await openMobileWebSocket(ws)
    } finally {
      stateStore.close()
    }

    const frames = sent.filter((envelope) => envelope['type'] === 'frame')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.['frame']).toMatchObject({
      frameId: 'hrc-41',
      lastHrcSeq: 41,
      lastMessageSeq: 5,
      blocks: [{ payload: { envelopeId: 'EN-00005', messageSeq: 5 } }],
    })
  })

  test('room-key messages query is ledger-only because HRC rows have no room identity', async () => {
    const collaboration = ledger({
      messages: [ledgerMessage({ legacyMessageId: 'msg-legacy' })],
    })
    let hrcListCalls = 0
    const hrcClient = {
      async listMessages() {
        hrcListCalls += 1
        return { messages: [hrcMessage()] }
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/mobile/messages/query',
          body: { roomKey: 'T-07614', limit: 20, order: 'desc' },
        })
        const payload = await fixture.json<{ messages: CollaborationMessage[] }>(response)

        expect(response.status).toBe(200)
        expect(hrcListCalls).toBe(0)
        expect(payload.messages).toEqual([
          expect.objectContaining({
            messageId: 'EN-00005',
            roomKey: 'T-07614',
            sender: { principalRef: 'agent:lance' },
          }),
        ])
      },
      { hrcClient, collaborationLedger: collaboration }
    )
  })

  test('human DM writes only the agent:lance collaboration ledger', async () => {
    const principals: string[] = []
    const sayCalls: CollaborationSayInput[] = []
    const humanLedger = ledger({ sayCalls })
    const semanticCalls: unknown[] = []
    const requestMessage = hrcMessage('msg-delivered')
    const hrcClient = {
      async semanticDm(input: unknown) {
        semanticCalls.push(input)
        return { request: requestMessage }
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/mobile/messages/dm',
          body: {
            body: 'Please reply in the room.',
            roomKey: 'T-07614',
            idempotencyKey: 'ios:message:flag-day-1',
            to: { kind: 'session', sessionRef: SESSION_REF },
          },
        })

        expect(response.status).toBe(200)
        expect(semanticCalls).toHaveLength(0)
        expect(principals).toEqual(['agent:lance'])
        expect(sayCalls).toEqual([
          {
            ref: 'T-07614',
            to: [MEMBER_REF],
            body: 'Please reply in the room.',
            idempotencyKey: 'ios:message:flag-day-1',
          },
        ])
      },
      {
        hrcClient,
        collaborationLedgerForPrincipal: async (principalRef) => {
          principals.push(principalRef)
          return humanLedger
        },
      }
    )
  })
})
