import { describe, expect, test } from 'bun:test'

import { runTaskPromoteCommand } from '../../src/commands/task-promote.js'
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

describe('task promote command', () => {
  test('promotes a wrkq task and returns text output', async () => {
    const client = createClientDouble({
      async promoteTask(input) {
        expect(input.actorRole).toBe('triager')
        expect(input.roleMap).toEqual({ implementer: 'larry', tester: 'curly' })
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            kind: 'bug',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            lifecycleState: 'open',
            phase: 'open',
            riskClass: 'medium',
            roleMap: input.roleMap,
            version: 1,
          },
          transition: {
            taskId: 'T-12345',
            transitionEventId: 'tte_promote',
            timestamp: '2026-04-20T00:00:00.000Z',
            from: { phase: '', lifecycleState: 'open' },
            to: { phase: 'open', lifecycleState: 'open' },
            actor: { agentId: 'tracy', role: 'triager' },
            requiredEvidenceKinds: [],
            evidenceKinds: [],
            waivedEvidenceKinds: [],
            expectedVersion: 0,
            nextVersion: 1,
          },
        }
      },
    })

    const output = await runTaskPromoteCommand(
      [
        '--task',
        'T-12345',
        '--preset',
        'code_defect_fastlane',
        '--preset-version',
        '1',
        '--risk-class',
        'medium',
        '--actor',
        'tracy',
        '--role',
        'implementer:larry',
        '--role',
        'tester:curly',
      ],
      { createClient: () => client }
    )

    expect(output.format).toBe('text')
    expect(output).toMatchObject({ text: expect.stringContaining('Promoted T-12345') })
  })

  test('rejects duplicate roles', async () => {
    await expect(
      runTaskPromoteCommand(
        [
          '--task',
          'T-12345',
          '--preset',
          'code_defect_fastlane',
          '--preset-version',
          '1',
          '--risk-class',
          'medium',
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
