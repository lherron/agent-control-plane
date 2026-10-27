import { expect, test } from 'bun:test'
import { createFetchQueue, runCli } from '../cli-test-helpers.js'

const binding = {
  bindingId: 'ifb_123',
  gatewayId: 'acp-discord-smoke',
  gatewayType: 'discord',
  conversationRef: 'channel:123',
  sessionRef: { scopeRef: 'agent:cody:project:agent-spaces:task:discord', laneRef: 'main' },
  projectId: 'agent-spaces',
  status: 'active',
  createdAt: '2026-04-20T00:00:00.000Z',
  updatedAt: '2026-04-20T00:00:00.000Z',
}

test('admin interface binding list through CLI and HTTP client', async () => {
  const queue = createFetchQueue([
    {
      body: { bindings: [binding] },
      assert(request) {
        expect(request.method).toBe('GET')
        const url = new URL(request.url)
        expect(url.pathname).toBe('/v1/interface/bindings')
        expect(Object.fromEntries(url.searchParams)).toEqual({
          gatewayId: 'acp-discord-smoke',
          conversationRef: 'channel:123',
          projectId: 'agent-spaces',
        })
      },
    },
  ])
  const result = await runCli(
    [
      'admin',
      'interface',
      'binding',
      'list',
      '--gateway',
      'acp-discord-smoke',
      '--conversation-ref',
      'channel:123',
      '--project',
      'agent-spaces',
    ],
    { fetchImpl: queue.fetchImpl }
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(binding.sessionRef.scopeRef)
  expect(queue.calls).toHaveLength(1)
})
