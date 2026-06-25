import { describe, expect, test } from 'bun:test'

import { runTaskShowCommand } from '../../src/commands/task-show.js'
import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'
import type { AcpClient } from '../../src/http-client.js'
import { AcpClientHttpError } from '../../src/http-client.js'

function createClientDouble(overrides: Partial<AcpClient>): AcpClient {
  return {
    createTask: overrides.createTask ?? (() => Promise.reject(new Error('not implemented'))),
    getTask: overrides.getTask ?? (() => Promise.reject(new Error('not implemented'))),
    addEvidence: overrides.addEvidence ?? (() => Promise.reject(new Error('not implemented'))),
    transitionTask:
      overrides.transitionTask ?? (() => Promise.reject(new Error('not implemented'))),
    listInterfaceBindings:
      overrides.listInterfaceBindings ?? (() => Promise.reject(new Error('not implemented'))),
    upsertInterfaceBinding:
      overrides.upsertInterfaceBinding ?? (() => Promise.reject(new Error('not implemented'))),
  }
}

describe('workflow task commands', () => {
  test('transitions a task with inline evidence', async () => {
    const client = createClientDouble({
      async transitionTask(input) {
        expect(input).toMatchObject({
          taskId: 'T-12345',
          transitionId: 'close_success',
          role: 'owner',
          expectedTaskVersion: 1,
          inlineEvidence: [{ kind: 'completion_note', ref: 'artifact://done' }],
          idempotencyKey: 'cli:transition',
        })
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'closed', outcome: 'success' },
            version: 2,
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'larry' } },
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
          event: {
            eventId: 'wevt_1',
            taskId: 'T-12345',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            type: 'transition.applied',
            actor: { kind: 'agent', id: 'larry' },
            observedTaskVersion: 1,
            nextTaskVersion: 2,
            idempotencyKey: 'cli:transition',
            payload: { transitionId: 'close_success' },
            createdAt: '2026-05-09T00:00:00.000Z',
          },
          effects: [],
        }
      },
    })

    const output = await runTaskTransitionCommand(
      [
        '--task',
        'T-12345',
        '--transition',
        'close_success',
        '--actor',
        'larry',
        '--role',
        'owner',
        '--expected-version',
        '1',
        '--evidence',
        'completion_note=artifact://done',
        '--idempotency-key',
        'cli:transition',
      ],
      { createClient: () => client }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Transitioned T-12345') })
  })

  test('transitions a task with attached evidence references', async () => {
    const client = createClientDouble({
      async transitionTask(input) {
        expect(input).toMatchObject({
          taskId: 'T-12345',
          transitionId: 'close_success',
          role: 'owner',
          expectedTaskVersion: 1,
          evidenceRefs: ['evd_1', 'evd_2'],
          idempotencyKey: 'cli:transition',
        })
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'closed', outcome: 'success' },
            version: 2,
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'larry' } },
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
          event: {
            eventId: 'wevt_1',
            taskId: 'T-12345',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            type: 'transition.applied',
            actor: { kind: 'agent', id: 'larry' },
            observedTaskVersion: 1,
            nextTaskVersion: 2,
            idempotencyKey: 'cli:transition',
            payload: { transitionId: 'close_success' },
            createdAt: '2026-05-09T00:00:00.000Z',
          },
          effects: [],
        }
      },
    })

    const output = await runTaskTransitionCommand(
      [
        '--task',
        'T-12345',
        '--transition',
        'close_success',
        '--actor',
        'larry',
        '--role',
        'owner',
        '--expected-version',
        '1',
        '--evidence-ref',
        'evd_1',
        '--evidence-ref',
        'evd_2',
        '--idempotency-key',
        'cli:transition',
      ],
      { createClient: () => client }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Transitioned T-12345') })
  })

  test('shows workflow task details', async () => {
    const client = createClientDouble({
      async getTask(input) {
        expect(input).toEqual({ taskId: 'T-12345' })
        return {
          source: 'wrkf',
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'active', phase: 'doing' },
            version: 1,
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'larry' } },
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
          instance: { revision: 1 },
          next: { transitions: [] },
          timeline: [],
          evidence: [],
          obligations: [],
          effects: [],
          runs: [],
        }
      },
    })

    const output = await runTaskShowCommand(['--task', 'T-12345'], { createClient: () => client })
    expect(output).toMatchObject({ text: expect.stringContaining('Workflow: basic@1') })
  })

  test('surfaces transition server rejection', async () => {
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
          '--transition',
          'close_success',
          '--actor',
          'larry',
          '--role',
          'owner',
          '--expected-version',
          '1',
          '--idempotency-key',
          'cli:transition',
        ],
        { createClient: () => client }
      )
    ).rejects.toBeInstanceOf(AcpClientHttpError)
  })
})
