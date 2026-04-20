import { describe, expect, test } from 'bun:test'

import { runTaskShowCommand } from '../../src/commands/task-show.js'
import type { AcpClient } from '../../src/http-client.js'
import { AcpClientHttpError } from '../../src/http-client.js'

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

describe('task show command', () => {
  test('shows task details with role context', async () => {
    const client = createClientDouble({
      async getTask(input) {
        expect(input).toEqual({ taskId: 'T-12345', role: 'tester' })
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            kind: 'task',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            lifecycleState: 'open',
            phase: 'green',
            riskClass: 'medium',
            roleMap: { implementer: 'larry', tester: 'curly' },
            version: 1,
          },
          context: {
            phase: 'green',
            requiredEvidenceKinds: ['qa_bundle'],
            hintsText: 'Phase: green',
          },
        }
      },
    })

    const output = await runTaskShowCommand(['--task', 'T-12345', '--role', 'tester'], {
      createClient: () => client,
    })

    expect(output.format).toBe('text')
    expect(output).toMatchObject({ text: expect.stringContaining('Current task context:') })
  })

  test('surfaces server rejection', async () => {
    const client = createClientDouble({
      async getTask() {
        throw new AcpClientHttpError(404, {
          error: { code: 'not_found', message: 'task not found: T-missing' },
        })
      },
    })

    await expect(
      runTaskShowCommand(['--task', 'T-missing'], { createClient: () => client })
    ).rejects.toBeInstanceOf(AcpClientHttpError)
  })
})
