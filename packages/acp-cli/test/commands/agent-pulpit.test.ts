import { describe, expect, test } from 'bun:test'

import { runAgentPulpitCommand } from '../../src/commands/agent-pulpit.js'
import type { AcpClient } from '../../src/http-client.js'

function clientDouble(overrides: Partial<AcpClient>): AcpClient {
  return {
    createAgentPulpitMessage:
      overrides.createAgentPulpitMessage ?? (() => Promise.reject(new Error('not implemented'))),
  } as AcpClient
}

describe('agent-pulpit send command', () => {
  test('sends using an explicit binding and prints generated idempotency key', async () => {
    const output = await runAgentPulpitCommand(
      ['send', '--binding', 'ifb_mneme', '--text', 'smoke'],
      {
        createClient: () =>
          clientDouble({
            async createAgentPulpitMessage(input) {
              expect(input.bindingId).toBe('ifb_mneme')
              expect(input.text).toBe('smoke')
              expect(input.idempotencyKey).toMatch(/^acp-cli:agent-pulpit:/)
              return {
                idempotencyKey: input.idempotencyKey,
                delivery: {
                  deliveryRequestId: 'dr_cli_binding',
                  gatewayId: 'acp-discord-smoke',
                  bindingId: 'ifb_mneme',
                  sessionRef: { scopeRef: 'agent:mneme:project:media-ingest', laneRef: 'main' },
                  conversationRef: 'channel:mneme',
                  body: { kind: 'text/markdown', text: 'smoke' },
                  status: 'queued',
                  createdAt: '2026-06-10T00:00:00.000Z',
                },
              }
            },
          }),
      }
    )

    expect(output.format).toBe('text')
    expect(output.text).toContain('Queued dr_cli_binding (queued)')
    expect(output.text).toContain('idempotencyKey: acp-cli:agent-pulpit:')
  })

  test('sends using primary gateway type, agent, and project selectors', async () => {
    const output = await runAgentPulpitCommand(
      [
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
      {
        createClient: () =>
          clientDouble({
            async createAgentPulpitMessage(input) {
              expect(input).toMatchObject({
                gatewayType: 'discord',
                agentId: 'mneme',
                projectId: 'media-ingest',
                laneRef: 'main',
                text: 'done',
                idempotencyKey: 'media-ingest:done:1',
              })
              return {
                idempotencyKey: input.idempotencyKey,
                delivery: {
                  deliveryRequestId: 'dr_cli_primary',
                  gatewayId: 'acp-discord-smoke',
                  bindingId: 'ifb_mneme',
                  sessionRef: { scopeRef: 'agent:mneme:project:media-ingest', laneRef: 'main' },
                  conversationRef: 'channel:mneme',
                  body: { kind: 'text/markdown', text: 'done' },
                  status: 'queued',
                  createdAt: '2026-06-10T00:00:00.000Z',
                },
              }
            },
          }),
      }
    )

    expect(output.format).toBe('json')
    expect(output.body).toMatchObject({
      idempotencyKey: 'media-ingest:done:1',
      delivery: { deliveryRequestId: 'dr_cli_primary' },
    })
  })
})
