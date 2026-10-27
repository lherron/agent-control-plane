import { describe, expect, test } from 'bun:test'

import type { HrcEventTail, HrcLifecycleEvent } from 'hrc-core'
import type { HrcEventTailOptions } from 'hrc-sdk'

import type { AcpHrcClient } from '../src/deps.js'
import {
  decodePluginEventCursor,
  encodePluginEventCursor,
} from '../src/handlers/plugin-event-cursor.js'
import { withWiredServer } from './fixtures/wired-server.js'

const EVENT: HrcLifecycleEvent = {
  hrcSeq: 37,
  streamSeq: 42,
  sourceRef: 'node:peer',
  originSeq: 9,
  ts: '2026-08-23T18:00:00.000Z',
  hostSessionId: 'hsid-1',
  scopeRef: 'agent:cody:project:agent-control-plane',
  laneRef: 'primary',
  generation: 3,
  runtimeId: 'runtime-1',
  runId: 'run-1',
  launchId: 'launch-1',
  appId: 'app-1',
  appSessionKey: 'session-key-1',
  category: 'turn',
  eventKind: 'future.kind',
  transport: 'headless',
  errorCode: 'future_error',
  replayed: true,
  payload: { nested: { list: [1, 'two', { three: true }] } },
}

function hrcClientWithTail(
  tail: HrcEventTail,
  onOptions?: (options: HrcEventTailOptions) => void
): AcpHrcClient {
  return {
    async tailEvents(options) {
      onOptions?.(options)
      return tail
    },
  } as unknown as AcpHrcClient
}

describe('ACP plugin event HTTP routes', () => {
  test('tail forwards every exact filter and binds its cursor to the global head', async () => {
    let observed: HrcEventTailOptions | undefined
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/plugins/events/tail?limit=17&sourceRef=node%3Apeer&hostSessionId=hsid-1&generation=3&scopeRef=agent%3Acody%3Aproject%3Aagent-control-plane&laneRef=primary&runtimeId=runtime-1&runId=run-1&category=turn&eventKind=future.kind',
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<{
          ok: true
          value: { events: HrcLifecycleEvent[]; cursor: string; truncated: boolean }
          error: null
        }>(response)
        expect(body).toEqual({
          ok: true,
          value: {
            events: [EVENT],
            cursor: encodePluginEventCursor({
              ledgerIncarnationId: 'ledger-a',
              hrcSeq: 99,
            }),
            truncated: true,
          },
          error: null,
        })
        expect(decodePluginEventCursor(body.value.cursor)).toEqual({
          ledgerIncarnationId: 'ledger-a',
          hrcSeq: 99,
        })
      },
      {
        hrcClient: hrcClientWithTail(
          {
            events: [EVENT],
            ledgerIncarnationId: 'ledger-a',
            headHrcSeq: 99,
            truncated: true,
          },
          (options) => {
            observed = options
          }
        ),
      }
    )
    expect(observed).toEqual({
      limit: 17,
      sourceRef: 'node:peer',
      hostSessionId: 'hsid-1',
      generation: 3,
      scopeRef: 'agent:cody:project:agent-control-plane',
      laneRef: 'primary',
      runtimeId: 'runtime-1',
      runId: 'run-1',
      category: 'turn',
      eventKind: 'future.kind',
    })
  })

  test('tail rejects missing, out-of-range, duplicate, and unknown query parameters', async () => {
    await withWiredServer(
      async (fixture) => {
        for (const [path, message] of [
          ['/v1/plugins/events/tail', 'limit is required'],
          ['/v1/plugins/events/tail?limit=0', 'limit is required'],
          ['/v1/plugins/events/tail?limit=501', 'limit must be an integer from 1 through 500'],
          ['/v1/plugins/events/tail?limit=1&limit=2', 'query parameter limit is duplicated'],
          [
            '/v1/plugins/events/tail?limit=1&permission=all',
            'unsupported query parameter: permission',
          ],
        ] as const) {
          const response = await fixture.request({ method: 'GET', path })
          expect({ path, status: response.status }).toEqual({ path, status: 400 })
          const body = await fixture.json<{ error: { code: string; message: string } }>(response)
          expect(body).toMatchObject({
            ok: false,
            value: null,
            error: { code: 'malformed_request' },
          })
          expect(body.error.message).toContain(message)
        }
      },
      {
        hrcClient: hrcClientWithTail({
          events: [],
          ledgerIncarnationId: 'a',
          headHrcSeq: 0,
          truncated: false,
        }),
      }
    )
  })

  test('resolve-cursor reads fresh authority for now, valid, stale, and future positions', async () => {
    let authority: HrcEventTail = {
      events: [],
      ledgerIncarnationId: 'ledger-a',
      headHrcSeq: 40,
      truncated: false,
    }
    let authorityReads = 0
    const client = hrcClientWithTail(authority, () => {
      authorityReads += 1
    })
    client.tailEvents = async (options) => {
      authorityReads += 1
      expect(options).toEqual({ limit: 1 })
      return authority
    }

    await withWiredServer(
      async (fixture) => {
        const nowResponse = await fixture.request({
          method: 'POST',
          path: '/v1/plugins/events/resolve-cursor',
          body: { cursor: 'now' },
        })
        expect(nowResponse.status).toBe(200)
        const now = await fixture.json<{
          value: { cursor: string; ledgerIncarnationId: string; hrcSeq: number }
        }>(nowResponse)
        expect(now.value).toMatchObject({ ledgerIncarnationId: 'ledger-a', hrcSeq: 40 })

        const validCursor = encodePluginEventCursor({
          ledgerIncarnationId: 'ledger-a',
          hrcSeq: 12,
        })
        const validResponse = await fixture.request({
          method: 'POST',
          path: '/v1/plugins/events/resolve-cursor',
          body: { cursor: validCursor },
        })
        expect(validResponse.status).toBe(200)
        expect(await fixture.json(validResponse)).toMatchObject({
          ok: true,
          value: { cursor: validCursor, hrcSeq: 12, headHrcSeq: 40 },
        })

        const futureCursor = encodePluginEventCursor({
          ledgerIncarnationId: 'ledger-a',
          hrcSeq: 41,
        })
        const futureResponse = await fixture.request({
          method: 'POST',
          path: '/v1/plugins/events/resolve-cursor',
          body: { cursor: futureCursor },
        })
        expect(futureResponse.status).toBe(409)
        expect(await fixture.json(futureResponse)).toMatchObject({
          error: { code: 'cursor_future' },
        })

        authority = { ...authority, ledgerIncarnationId: 'ledger-b', headHrcSeq: 12 }
        const staleResponse = await fixture.request({
          method: 'POST',
          path: '/v1/plugins/events/resolve-cursor',
          body: { cursor: validCursor },
        })
        expect(staleResponse.status).toBe(409)
        expect(await fixture.json(staleResponse)).toMatchObject({
          error: { code: 'cursor_invalid' },
        })
      },
      { hrcClient: client }
    )
    expect(authorityReads).toBe(4)
  })

  test('plain GET /v1/plugins/events without upgrade returns 426 upgrade_required in the plugin envelope', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({ method: 'GET', path: '/v1/plugins/events' })
      expect(response.status).toBe(426)
      expect(await fixture.json(response)).toEqual({
        ok: false,
        value: null,
        error: {
          code: 'upgrade_required',
          message: 'Use a WebSocket upgrade for /v1/plugins/events.',
        },
      })
    })
  })

  test('resolve-cursor rejects a non-canonical or padded cursor with the decode reason', async () => {
    const client = hrcClientWithTail({
      events: [],
      ledgerIncarnationId: 'ledger-a',
      headHrcSeq: 40,
      truncated: false,
    })

    await withWiredServer(
      async (fixture) => {
        const resolve = (cursor: string) =>
          fixture.request({
            method: 'POST',
            path: '/v1/plugins/events/resolve-cursor',
            body: { cursor },
          })
        const now = await fixture.json<{ value: { cursor: string } }>(await resolve('now'))
        const reissued = await fixture.json<{ value: { cursor: string } }>(
          await resolve(now.value.cursor)
        )
        expect(reissued.value.cursor).toBe(now.value.cursor)

        const nonCanonical = Buffer.from(
          JSON.stringify({ hrcSeq: 40, ledgerIncarnationId: 'ledger-a', v: 1 })
        ).toString('base64url')
        for (const [cursor, reason] of [
          [nonCanonical, 'canonically encoded'],
          [`${now.value.cursor}=`, 'encoding is invalid'],
        ] as const) {
          const response = await resolve(cursor)
          expect({ reason, status: response.status }).toEqual({ reason, status: 400 })
          const body = await fixture.json<{ ok: boolean; error: { message: string } }>(response)
          expect(body.ok).toBe(false)
          expect(body.error.message).toContain(reason)
        }
      },
      { hrcClient: client }
    )
  })

  test('resolve-cursor preserves the result envelope for malformed JSON', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.handler(
        new Request('http://acp.test/v1/plugins/events/resolve-cursor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        })
      )
      expect(response.status).toBe(400)
      expect(await fixture.json(response)).toEqual({
        ok: false,
        value: null,
        error: { code: 'malformed_request', message: 'request body must be valid JSON' },
      })
    })
  })
})
