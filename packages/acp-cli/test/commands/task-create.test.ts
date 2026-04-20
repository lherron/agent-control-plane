import { describe, expect, test } from 'bun:test'

import { runTaskCreateCommand } from '../../src/commands/task-create.js'
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

describe('task create command', () => {
  test('creates a task and returns text output', async () => {
    const client = createClientDouble({
      async createTask(input) {
        expect(input.kind).toBe('task')
        expect(input.roleMap).toEqual({ implementer: 'larry', tester: 'curly' })
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            kind: 'task',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            lifecycleState: 'open',
            phase: 'open',
            riskClass: 'medium',
            roleMap: input.roleMap,
            version: 0,
          },
        }
      },
    })

    const output = await runTaskCreateCommand(
      [
        '--preset',
        'code_defect_fastlane',
        '--preset-version',
        '1',
        '--risk-class',
        'medium',
        '--project',
        'P-00001',
        '--actor',
        'tracy',
        '--role',
        'implementer:larry',
        '--role',
        'tester:curly',
      ],
      {
        createClient: () => client,
      }
    )

    expect(output.format).toBe('text')
    expect(output).toMatchObject({ text: expect.stringContaining('Created T-12345') })
  })

  test('rejects duplicate roles', async () => {
    await expect(
      runTaskCreateCommand(
        [
          '--preset',
          'code_defect_fastlane',
          '--preset-version',
          '1',
          '--risk-class',
          'medium',
          '--project',
          'P-00001',
          '--actor',
          'tracy',
          '--role',
          'implementer:larry',
          '--role',
          'implementer:curly',
        ],
        { createClient: () => createClientDouble({}) }
      )
    ).rejects.toThrow('duplicate role assignment for implementer')
  })
})
