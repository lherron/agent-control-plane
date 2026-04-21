import { describe, expect, test } from 'bun:test'

import { runTaskTransitionsCommand } from '../../src/commands/task-transitions.js'
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

describe('task transitions command', () => {
  test('renders transition history', async () => {
    const client = createClientDouble({
      async listTransitions(input) {
        expect(input).toEqual({ taskId: 'T-12345' })
        return {
          transitions: [
            {
              taskId: 'T-12345',
              transitionEventId: 'tte_123',
              timestamp: '2026-04-20T00:00:00.000Z',
              from: { phase: 'open', lifecycleState: 'open' },
              to: { phase: 'red', lifecycleState: 'open' },
              actor: { agentId: 'larry', role: 'implementer' },
              requiredEvidenceKinds: ['tdd_red_bundle'],
              evidenceKinds: ['tdd_red_bundle'],
              waivedEvidenceKinds: [],
              expectedVersion: 0,
              nextVersion: 1,
            },
          ],
        }
      },
    })

    const output = await runTaskTransitionsCommand(['--task', 'T-12345'], {
      createClient: () => client,
    })

    expect(output).toMatchObject({
      format: 'text',
      text: expect.stringContaining('Transitions:'),
    })
  })

  test('requires task id', async () => {
    await expect(
      runTaskTransitionsCommand([], { createClient: () => createClientDouble({}) })
    ).rejects.toThrow('--task is required')
  })
})
