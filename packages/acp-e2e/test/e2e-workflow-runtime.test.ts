import { describe, expect, test } from 'bun:test'

import { withSeedStack } from './fixtures/seed-stack.js'

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

function expectSuccess(result: { exitCode: number; stderr: string }): void {
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
}

describe('ACP durable workflow runtime e2e', () => {
  test('creates, shows, transitions, and persists a basic workflow task', async () => {
    await withSeedStack(async (stack) => {
      const createdResult = await stack.cli.run([
        'task',
        'create',
        '--workflow',
        'basic@1',
        '--project',
        stack.seed.projectId,
        '--goal',
        'complete workflow e2e',
        '--actor',
        'larry',
        '--role',
        'owner:larry',
        '--idempotency-key',
        'e2e:workflow:create',
        '--json',
      ])
      expectSuccess(createdResult)
      const created = parseJson<{
        task: { taskId: string; workflow: { id: string; version: number; hash: string } }
      }>(createdResult.stdout)

      expect(created.task.workflow.id).toBe('basic')
      expect(created.task.workflow.version).toBe(1)
      expect(created.task.workflow.hash).toMatch(/^sha256:/)

      const showResult = await stack.cli.run([
        'task',
        'show',
        '--task',
        created.task.taskId,
        '--json',
      ])
      expectSuccess(showResult)
      expect(
        parseJson<{ task: { state: { status: string; phase: string } } }>(showResult.stdout).task
          .state
      ).toEqual({ status: 'open', phase: 'todo' })

      const startResult = await stack.cli.run([
        'task',
        'transition',
        '--task',
        created.task.taskId,
        '--transition',
        'start',
        '--actor',
        'larry',
        '--role',
        'owner',
        '--expected-version',
        '0',
        '--idempotency-key',
        'e2e:workflow:start',
        '--json',
      ])
      expectSuccess(startResult)
      expect(
        parseJson<{ task: { state: { status: string; phase: string }; version: number } }>(
          startResult.stdout
        ).task
      ).toMatchObject({ state: { status: 'active', phase: 'doing' }, version: 1 })

      const closeResult = await stack.cli.run([
        'task',
        'transition',
        '--task',
        created.task.taskId,
        '--transition',
        'close_success',
        '--actor',
        'larry',
        '--role',
        'owner',
        '--expected-version',
        '1',
        '--evidence',
        'completion_note=artifact://workflow-e2e/done',
        '--idempotency-key',
        'e2e:workflow:close',
        '--json',
      ])
      expectSuccess(closeResult)
      expect(
        parseJson<{ task: { state: { status: string; outcome: string }; version: number } }>(
          closeResult.stdout
        ).task
      ).toMatchObject({ state: { status: 'closed', outcome: 'success' }, version: 2 })

      const snapshot = stack.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.events.map((event) => event.type)).toContain('transition.applied')
      expect(snapshot.evidence.map((item) => item.kind)).toEqual(['completion_note'])
      expect(snapshot.idempotency.map((entry) => entry.key).sort()).toEqual([
        'e2e:workflow:close',
        'e2e:workflow:create',
        'e2e:workflow:start',
      ])
    })
  })
})
