import { describe, expect, test } from 'bun:test'

import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'
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

describe('task transition command', () => {
  test('transitions a task with evidence refs and handoff request', async () => {
    const client = createClientDouble({
      async transitionTask(input) {
        expect(input.evidenceRefs).toEqual(['artifact://red/1', 'artifact://logs/2'])
        expect(input.requestHandoff).toBe(true)
        expect(input.waivers).toEqual([
          {
            kind: 'waiver',
            ref: 'artifact://waivers/1',
            details: { waiverKind: 'evidence_override' },
          },
        ])
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            kind: 'task',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            lifecycleState: 'open',
            phase: 'red',
            riskClass: 'medium',
            roleMap: { implementer: 'larry', tester: 'curly' },
            version: 1,
          },
          transition: {
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
          handoff: { handoffId: 'hf_1', state: 'open' },
          wake: { wakeId: 'wk_1', state: 'queued' },
        }
      },
    })

    const output = await runTaskTransitionCommand(
      [
        '--task',
        'T-12345',
        '--to',
        'red',
        '--actor',
        'larry',
        '--actor-role',
        'implementer',
        '--expected-version',
        '0',
        '--evidence',
        'artifact://red/1,artifact://logs/2',
        '--request-handoff',
        '--waiver',
        'evidence_override:artifact://waivers/1',
      ],
      { createClient: () => client }
    )

    expect(output).toMatchObject({
      text: expect.stringContaining('Transitioned T-12345 open → red'),
    })
  })

  test('surfaces 422 rejection', async () => {
    const client = createClientDouble({
      async transitionTask() {
        throw new AcpClientHttpError(422, {
          error: { code: 'missing_evidence', message: 'Missing required evidence' },
        })
      },
    })

    await expect(
      runTaskTransitionCommand(
        [
          '--task',
          'T-12345',
          '--to',
          'green',
          '--actor',
          'larry',
          '--actor-role',
          'implementer',
          '--expected-version',
          '0',
        ],
        { createClient: () => client }
      )
    ).rejects.toBeInstanceOf(AcpClientHttpError)
  })
})
