import { describe, expect, test } from 'bun:test'

import { runAdminInterfaceBindingListCommand } from '../../src/commands/admin-interface-binding-list.js'
import type { AcpClient } from '../../src/http-client.js'

function createClientDouble(overrides: Partial<AcpClient>): AcpClient {
  return {
    createTask: overrides.createTask ?? (() => Promise.reject(new Error('not implemented'))),
    promoteTask: overrides.promoteTask ?? (() => Promise.reject(new Error('not implemented'))),
    getTask: overrides.getTask ?? (() => Promise.reject(new Error('not implemented'))),
    addEvidence: overrides.addEvidence ?? (() => Promise.reject(new Error('not implemented'))),
    transitionTask:
      overrides.transitionTask ?? (() => Promise.reject(new Error('not implemented'))),
    listTransitions:
      overrides.listTransitions ?? (() => Promise.reject(new Error('not implemented'))),
    listInterfaceBindings:
      overrides.listInterfaceBindings ?? (() => Promise.reject(new Error('not implemented'))),
    upsertInterfaceBinding:
      overrides.upsertInterfaceBinding ?? (() => Promise.reject(new Error('not implemented'))),
  }
}

describe('admin interface binding list command', () => {
  test('lists interface bindings with filters', async () => {
    const client = createClientDouble({
      async listInterfaceBindings(input) {
        expect(input).toEqual({
          gatewayId: 'acp-discord-smoke',
          conversationRef: 'channel:123',
          projectId: 'agent-spaces',
        })

        return {
          bindings: [
            {
              bindingId: 'ifb_123',
              gatewayId: 'acp-discord-smoke',
              conversationRef: 'channel:123',
              sessionRef: {
                scopeRef: 'agent:cody:project:agent-spaces:task:discord',
                laneRef: 'main',
              },
              projectId: 'agent-spaces',
              status: 'active',
              createdAt: '2026-04-20T00:00:00.000Z',
              updatedAt: '2026-04-20T00:00:00.000Z',
            },
          ],
        }
      },
    })

    const output = await runAdminInterfaceBindingListCommand(
      [
        '--gateway',
        'acp-discord-smoke',
        '--conversation-ref',
        'channel:123',
        '--project',
        'agent-spaces',
      ],
      { createClient: () => client }
    )

    expect(output.format).toBe('text')
    expect(output).toMatchObject({
      text: expect.stringContaining('agent:cody:project:agent-spaces:task:discord'),
    })
  })
})
