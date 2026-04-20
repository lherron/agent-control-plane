import { describe, expect, test } from 'bun:test'

import { runTaskEvidenceAddCommand } from '../../src/commands/task-evidence-add.js'
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
  }
}

describe('task evidence add command', () => {
  test('attaches evidence with build fields and details', async () => {
    const client = createClientDouble({
      async addEvidence(input) {
        expect(input.taskId).toBe('T-12345')
        expect(input.evidence[0]).toMatchObject({
          kind: 'qa_bundle',
          ref: 'artifact://qa/1',
          producedBy: { agentId: 'curly', role: 'tester' },
          build: { id: 'build-1', version: 'v1', env: 'staging' },
          details: { smoke: true },
        })
        return null
      },
    })

    const output = await runTaskEvidenceAddCommand(
      [
        '--task',
        'T-12345',
        '--kind',
        'qa_bundle',
        '--ref',
        'artifact://qa/1',
        '--actor',
        'curly',
        '--producer-role',
        'tester',
        '--build-id',
        'build-1',
        '--build-version',
        'v1',
        '--build-env',
        'staging',
        '--meta',
        '{"smoke":true}',
      ],
      { createClient: () => client }
    )

    expect(output).toMatchObject({
      format: 'text',
      text: expect.stringContaining('Attached evidence to T-12345'),
    })
  })

  test('requires producer-role', async () => {
    await expect(
      runTaskEvidenceAddCommand(
        [
          '--task',
          'T-12345',
          '--kind',
          'qa_bundle',
          '--ref',
          'artifact://qa/1',
          '--actor',
          'curly',
        ],
        { createClient: () => createClientDouble({}) }
      )
    ).rejects.toThrow('--producer-role is required')
  })
})
