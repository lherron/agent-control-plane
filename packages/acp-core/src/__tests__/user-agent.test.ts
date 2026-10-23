import { describe, expect, test } from 'bun:test'

import { clientFromUserAgent, firstPartyUserAgent, withUserAgent } from '../user-agent.js'

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
