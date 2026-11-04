import { describe, expect, test } from 'bun:test'

import {
  callerFromHeader,
  clientFromUserAgent,
  firstPartyUserAgent,
  resolveCaller,
  withUserAgent,
} from '../user-agent.js'

describe('first-party User-Agent', () => {
  test('names the package from its package.json', () => {
    expect(firstPartyUserAgent(new URL('../../package.json', import.meta.url))).toMatch(
      /^acp-core\/\d+\.\d+\.\d+/
    )
  })

  test('adds the agent unless the caller set one, keeping other headers', async () => {
    const seen: Headers[] = []
    const fetchImpl = withUserAgent(async (_input: Request | string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response(null)
    }, 'acp-cli/1.2.3')
    await fetchImpl('http://acp.test/a', { headers: { accept: 'application/json' } })
    await fetchImpl('http://acp.test/b', { headers: { 'user-agent': 'other/9' } })
    await fetchImpl(new Request('http://acp.test/c', { headers: { 'x-actor': 'clod' } }))
    expect(seen.map((headers) => headers.get('user-agent'))).toEqual([
      'acp-cli/1.2.3',
      'other/9',
      'acp-cli/1.2.3',
    ])
    expect(seen[0]?.get('accept')).toBe('application/json')
    expect(seen[2]?.get('x-actor')).toBe('clod')
  })

  test('parses only the leading name/version token', () => {
    expect(clientFromUserAgent('gateway-discord/0.1.0')).toBe('gateway-discord/0.1.0')
    expect(clientFromUserAgent('Mozilla/5.0 (Macintosh) Safari/605')).toBe('Mozilla/5.0')
    expect(clientFromUserAgent('curl')).toBe('unknown')
    expect(clientFromUserAgent('')).toBe('unknown')
    expect(clientFromUserAgent(null)).toBe('unknown')
  })
})

describe('caller identity', () => {
  test('resolves component, parent, seat, terminal, and unknown in order', () => {
    const env = { PRAESIDIUM_CALLER: 'parent:jobs', ASP_HANDLE: 'cody@agent-control-plane:T-12515' }
    expect(resolveCaller('acp-server:jobs', env, false)).toBe('acp-server:jobs')
    expect(resolveCaller(undefined, env, false)).toBe('parent:jobs')
    expect(resolveCaller(undefined, { ASP_HANDLE: env.ASP_HANDLE }, false)).toBe(env.ASP_HANDLE)
    expect(resolveCaller(undefined, {}, true)).toBe('tty')
    expect(resolveCaller(undefined, {}, false)).toBe('unknown')
  })

  test('validates the entire received header without refusing', () => {
    expect(callerFromHeader(null)).toBe('unknown')
    expect(callerFromHeader('acp-server:jobs')).toBe('acp-server:jobs')
    expect(callerFromHeader('A._:@/+-09')).toBe('A._:@/+-09')
    expect(callerFromHeader('x'.repeat(128))).toBe('x'.repeat(128))
    for (const caller of ['', 'bad caller', 'a,b', 'x'.repeat(129), 'a\n']) {
      expect(callerFromHeader(caller)).toBe('invalid')
    }
  })

  test('shared fetch adds caller while preserving explicit attribution', async () => {
    const seen: Headers[] = []
    const fetchImpl = withUserAgent(
      async (_input: Request | string | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return new Response(null)
      },
      'gateway-discord/1.2.3',
      'acp-server:gateway-discord'
    )
    await fetchImpl('http://acp.test/a')
    await fetchImpl(
      new Request('http://acp.test/b', { headers: { 'x-praesidium-caller': 'explicit' } })
    )
    expect(seen.map((headers) => headers.get('x-praesidium-caller'))).toEqual([
      'acp-server:gateway-discord',
      'explicit',
    ])
  })
})
