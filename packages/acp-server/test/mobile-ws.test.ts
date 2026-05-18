import { describe, expect, test } from 'bun:test'

import {
  MOBILE_WS_PATHS,
  abortMobileWebSocket,
  buildMobileErrorEnvelope,
  buildMobileUpgradeData,
  parseMobileEventCursor,
  parseMobileMessageCursor,
  parseMobileRawFlag,
  parseMobileRouteKind,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from '../src/handlers/mobile-ws.js'

import type { ResolvedAcpServerDeps } from '../src/deps.js'

function makeUrl(query: string): URL {
  return new URL(`http://acp.local/v1/mobile/timeline${query}`)
}

describe('parseMobileRouteKind', () => {
  test('recognises canonical mobile WS paths', () => {
    expect(parseMobileRouteKind(MOBILE_WS_PATHS.timeline)).toBe('timeline')
    expect(parseMobileRouteKind(MOBILE_WS_PATHS.diagnostics)).toBe('diagnostics')
  })

  test('returns undefined for other paths', () => {
    expect(parseMobileRouteKind('/v1/mobile/health')).toBeUndefined()
    expect(parseMobileRouteKind('/v1/mobile/timeline/extra')).toBeUndefined()
    expect(parseMobileRouteKind('/')).toBeUndefined()
  })
})

describe('parseMobileEventCursor', () => {
  test('defaults fromSeq to 1 and follow to false when params are missing', () => {
    const cursor = parseMobileEventCursor(makeUrl(''))
    expect(cursor).toEqual({ fromSeq: 1, follow: false })
  })

  test('clamps fromHrcSeq to >= 1', () => {
    const cursor = parseMobileEventCursor(makeUrl('?fromHrcSeq=0'))
    expect(cursor.fromSeq).toBe(1)
  })

  test('treats follow=true literally', () => {
    expect(parseMobileEventCursor(makeUrl('?follow=true')).follow).toBe(true)
    expect(parseMobileEventCursor(makeUrl('?follow=TRUE')).follow).toBe(false)
    expect(parseMobileEventCursor(makeUrl('?follow=1')).follow).toBe(false)
  })

  test('forwards hostSessionId when present, including empty string', () => {
    const present = parseMobileEventCursor(makeUrl('?hostSessionId=hsid-abc'))
    expect(present.hostSessionId).toBe('hsid-abc')

    const empty = parseMobileEventCursor(makeUrl('?hostSessionId='))
    expect('hostSessionId' in empty).toBe(true)
    expect(empty.hostSessionId).toBe('')

    const absent = parseMobileEventCursor(makeUrl(''))
    expect('hostSessionId' in absent).toBe(false)
  })

  test('forwards generation only when parseable', () => {
    expect(parseMobileEventCursor(makeUrl('?generation=12')).generation).toBe(12)
    expect('generation' in parseMobileEventCursor(makeUrl('?generation=abc'))).toBe(false)
    expect('generation' in parseMobileEventCursor(makeUrl(''))).toBe(false)
  })
})

describe('parseMobileMessageCursor', () => {
  test('returns 0 when param is absent', () => {
    expect(parseMobileMessageCursor(makeUrl(''))).toBe(0)
  })

  test('returns parsed integer when present', () => {
    expect(parseMobileMessageCursor(makeUrl('?fromMessageSeq=42'))).toBe(42)
  })

  test('returns NaN for unparseable values so callers can gate with isFinite', () => {
    expect(Number.isNaN(parseMobileMessageCursor(makeUrl('?fromMessageSeq=abc')))).toBe(true)
    expect(Number.isNaN(parseMobileMessageCursor(makeUrl('?fromMessageSeq=')))).toBe(true)
  })
})

describe('parseMobileRawFlag', () => {
  test('only the literal string "true" enables raw mode', () => {
    expect(parseMobileRawFlag(makeUrl('?raw=true'))).toBe(true)
    expect(parseMobileRawFlag(makeUrl('?raw=TRUE'))).toBe(false)
    expect(parseMobileRawFlag(makeUrl('?raw=1'))).toBe(false)
    expect(parseMobileRawFlag(makeUrl(''))).toBe(false)
  })
})

describe('buildMobileErrorEnvelope', () => {
  test('produces the canonical typed envelope', () => {
    expect(buildMobileErrorEnvelope('mobile_stream_failed', 'boom')).toEqual({
      type: 'error',
      code: 'mobile_stream_failed',
      message: 'boom',
    })
  })
})

describe('sendMobileJsonEnvelope', () => {
  test('JSON-stringifies the payload and forwards to ws.send', () => {
    const sent: string[] = []
    const ws = {
      send: (msg: string) => {
        sent.push(msg)
        return msg.length
      },
    }
    const ok = sendMobileJsonEnvelope(ws, { type: 'frame', n: 1 })
    expect(ok).toBe(true)
    expect(sent).toEqual([JSON.stringify({ type: 'frame', n: 1 })])
  })

  test('swallows send errors and returns false', () => {
    const ws = {
      send: () => {
        throw new Error('socket closed')
      },
    }
    expect(sendMobileJsonEnvelope(ws, { type: 'ping' })).toBe(false)
  })
})

describe('sendMobileErrorEnvelope', () => {
  test('sends a typed error envelope through sendMobileJsonEnvelope', () => {
    const sent: string[] = []
    const ws = {
      send: (msg: string) => {
        sent.push(msg)
        return msg.length
      },
    }
    sendMobileErrorEnvelope(ws, 'replay_gap_too_large', 'reconnect please')
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'error',
      code: 'replay_gap_too_large',
      message: 'reconnect please',
    })
  })
})

describe('abortMobileWebSocket', () => {
  test('aborts the controller', () => {
    const data = {
      deps: {} as ResolvedAcpServerDeps,
      url: 'http://acp.local/v1/mobile/timeline',
      kind: 'timeline' as const,
      abortController: new AbortController(),
    }
    abortMobileWebSocket({ data })
    expect(data.abortController.signal.aborted).toBe(true)
  })

  test('swallows errors raised by abort()', () => {
    const data = {
      deps: {} as ResolvedAcpServerDeps,
      url: 'http://acp.local/v1/mobile/timeline',
      kind: 'timeline' as const,
      abortController: {
        abort() {
          throw new Error('already disposed')
        },
        signal: new AbortController().signal,
      } as unknown as AbortController,
    }
    expect(() => abortMobileWebSocket({ data })).not.toThrow()
  })
})

describe('buildMobileUpgradeData', () => {
  test('returns a fresh AbortController and matching shape', () => {
    const deps = {} as ResolvedAcpServerDeps
    const data = buildMobileUpgradeData(deps, 'http://acp.local/v1/mobile/timeline', 'timeline')
    expect(data.deps).toBe(deps)
    expect(data.url).toBe('http://acp.local/v1/mobile/timeline')
    expect(data.kind).toBe('timeline')
    expect(data.abortController.signal.aborted).toBe(false)
  })
})
