import { describe, expect, test } from 'bun:test'

import { runAdminInterfaceBindingDisableCommand } from '../../src/commands/admin-interface-binding-disable.js'
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

describe('admin interface binding disable command', () => {
  test('disables an existing interface binding by lookup', async () => {
    const client = createClientDouble({
      async listInterfaceBindings(input) {
        expect(input).toEqual({
          gatewayId: 'acp-discord-smoke',
          conversationRef: 'channel:123',
        })

        return {
          bindings: [
            {
              bindingId: 'ifb_123',
              gatewayId: 'acp-discord-smoke',
              conversationRef: 'channel:123',
              sessionRef: {
                scopeRef: 'agent:rex:project:agent-spaces',
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
      async upsertInterfaceBinding(input) {
        expect(input).toEqual({
          gatewayId: 'acp-discord-smoke',
          conversationRef: 'channel:123',
          projectId: 'agent-spaces',
          sessionRef: {
            scopeRef: 'agent:rex:project:agent-spaces',
            laneRef: 'main',
          },
          status: 'disabled',
        })

        return {
          binding: {
            bindingId: 'ifb_123',
            gatewayId: 'acp-discord-smoke',
            conversationRef: 'channel:123',
            sessionRef: {
              scopeRef: 'agent:rex:project:agent-spaces',
              laneRef: 'main',
            },
            projectId: 'agent-spaces',
            status: 'disabled',
            createdAt: '2026-04-20T00:00:00.000Z',
            updatedAt: '2026-04-20T00:00:01.000Z',
          },
        }
      },
    })

    const output = await runAdminInterfaceBindingDisableCommand(
      ['--gateway', 'acp-discord-smoke', '--conversation-ref', 'channel:123'],
      { createClient: () => client }
    )

    expect(output.format).toBe('text')
    expect(output).toMatchObject({ text: 'Disabled binding ifb_123' })
  })
})
