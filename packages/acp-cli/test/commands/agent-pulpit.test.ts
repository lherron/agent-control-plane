import { expect, test } from 'bun:test'
import { createFetchQueue, runCli } from '../cli-test-helpers.js'

const delivery = {
  deliveryRequestId: 'dr_cli_binding',
  gatewayId: 'acp-discord-smoke',
  bindingId: 'ifb_mneme',
  sessionRef: { scopeRef: 'agent:mneme:project:media-ingest', laneRef: 'main' },
  conversationRef: 'channel:mneme',
  body: { kind: 'text/markdown', text: 'smoke' },
  status: 'queued',
  createdAt: '2026-06-10T00:00:00.000Z',
}

test('agent-pulpit send binding through CLI and HTTP client', async () => {
  const queue = createFetchQueue([
    {
      body: { idempotencyKey: 'acp-cli:agent-pulpit:fixture', delivery },
      assert(request) {
        expect(request.method).toBe('POST')
        expect(new URL(request.url).pathname).toBe('/v1/agent-pulpit/messages')
        expect(request.body).toMatchObject({
          bindingId: 'ifb_mneme',
          text: 'smoke',
          idempotencyKey: expect.stringMatching(/^acp-cli:agent-pulpit:/),
        })
      },
    },
  ])
  const result = await runCli(
    ['agent-pulpit', 'send', '--binding', 'ifb_mneme', '--text', 'smoke'],
    { fetchImpl: queue.fetchImpl }
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Queued dr_cli_binding (queued)')
  expect(result.stdout).toContain('idempotencyKey: acp-cli:agent-pulpit:')
  expect(queue.calls).toHaveLength(1)
})

test('agent-pulpit send selectors through CLI and HTTP client', async () => {
  const queue = createFetchQueue([
    {
      body: {
        idempotencyKey: 'media-ingest:done:1',
        delivery: { ...delivery, deliveryRequestId: 'dr_cli_primary' },
      },
      assert(request) {
        expect(request.method).toBe('POST')
        expect(new URL(request.url).pathname).toBe('/v1/agent-pulpit/messages')
        expect(request.body).toMatchObject({
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
          laneRef: 'main',
          text: 'done',
          idempotencyKey: 'media-ingest:done:1',
        })
      },
    },
  ])
  const result = await runCli(
    [
      'agent-pulpit',
      'send',
      '--gateway-type',
      'discord',
      '--agent',
      'mneme',
      '--project',
      'media-ingest',
      '--lane-ref',
      'main',
      '--text',
      'done',
      '--idempotency-key',
      'media-ingest:done:1',
      '--json',
    ],
    { fetchImpl: queue.fetchImpl }
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    idempotencyKey: 'media-ingest:done:1',
    delivery: { deliveryRequestId: 'dr_cli_primary' },
  })
  expect(queue.calls).toHaveLength(1)
})
