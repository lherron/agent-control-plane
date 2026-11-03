import { describe, expect, test } from 'bun:test'
import type { HrcClient } from 'hrc-sdk'
import { createHrcPort } from '../src/ports.js'

/**
 * T-12423 — holderLiveness reads live first. A fake HRC that answers
 * `GET /v1/runtimes` the way rusthrc does: `scope` is a prefix match, no `all`
 * means non-terminal rows only, and `limit` caps one page.
 */
const TERMINAL = new Set([
  'archived',
  'crashed',
  'dead',
  'disposed',
  'exited',
  'failed',
  'stale',
  'stopped',
  'terminal',
  'terminated',
])
const SCOPE = 'agent:cody:project:acp:task:T-1'
const claim = { by: 'agent:cody', scope: `${SCOPE}/lane:main`, node: 'max3', generation: 1 }

type Filter = { scope?: string; all?: boolean; limit?: number }

function fakeHrc(rows: Array<{ scopeRef: string; status: string }>, fail = false) {
  const calls: Filter[] = []
  const client = {
    async listRuntimes(filter: Filter) {
      calls.push(filter)
      if (fail) throw new Error('socket closed')
      const matched = rows.filter(
        (row) =>
          (filter.scope === undefined || row.scopeRef.startsWith(filter.scope)) &&
          (filter.all === true || !TERMINAL.has(row.status))
      )
      return filter.limit === undefined ? matched : matched.slice(0, filter.limit)
    },
  }
  const port = createHrcPort({
    principalRef: 'agent:acp',
    client: client as unknown as HrcClient,
  })
  return { port, calls }
}

describe('holderLiveness (T-12423)', () => {
  test('a live row answers live from the live query alone', async () => {
    const { port, calls } = fakeHrc([
      { scopeRef: SCOPE, status: 'terminated' },
      { scopeRef: SCOPE, status: 'ready' },
    ])
    expect(await port.holderLiveness(claim, 'max3')).toBe('live')
    expect(calls).toEqual([{ scope: SCOPE }])
  })

  test('only terminal history answers ended from one bounded page', async () => {
    const { port, calls } = fakeHrc([
      { scopeRef: SCOPE, status: 'terminated' },
      { scopeRef: SCOPE, status: 'archived' },
      { scopeRef: SCOPE, status: 'stale' },
    ])
    expect(await port.holderLiveness(claim, 'max3')).toBe('ended')
    expect(calls).toEqual([{ scope: SCOPE }, { scope: SCOPE, all: true, limit: 1 }])
  })

  test('a scope with no runtimes at all is unknown', async () => {
    const { port, calls } = fakeHrc([
      { scopeRef: 'agent:cody:project:acp:task:T-2', status: 'ready' },
    ])
    expect(await port.holderLiveness(claim, 'max3')).toBe('unknown')
    expect(calls).toHaveLength(2)
  })

  test('a holder on another node is unknown without reading HRC', async () => {
    const { port, calls } = fakeHrc([{ scopeRef: SCOPE, status: 'ready' }])
    expect(await port.holderLiveness(claim, 'svc')).toBe('unknown')
    expect(calls).toEqual([])
  })

  test('an HRC read failure is unknown, never ended', async () => {
    const { port } = fakeHrc([], true)
    expect(await port.holderLiveness(claim, 'max3')).toBe('unknown')
  })
})
