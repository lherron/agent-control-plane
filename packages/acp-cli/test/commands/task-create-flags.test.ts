import { describe, expect, test } from 'bun:test'

import { runTaskCreateCommand } from '../../src/commands/task-create.js'

function taskResponse() {
  return {
    task: {
      taskId: 'T-CUSTOM',
      projectId: 'P-1',
      workflow: { id: 'basic', version: 1, hash: 'sha256:wf' },
      state: { status: 'open', phase: 'todo' },
      version: 0,
      goal: 'collect evidence',
      roleBindings: {},
      createdAt: '2026-05-10T12:00:00.000Z',
      updatedAt: '2026-05-10T12:00:00.000Z',
    },
  }
}

describe('acp task create flag alignment', () => {
  test('passes --task-id and canonical --bind role bindings to the server', async () => {
    const seen: unknown[] = []
    await runTaskCreateCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--task-id',
        'T-CUSTOM',
        '--bind',
        'implementer=agent:larry',
        '--idempotency-key',
        'cli:create',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify(taskResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      taskId: 'T-CUSTOM',
      roleBindings: { implementer: { kind: 'agent', id: 'larry' } },
    })
  })

  test('keeps --role compat and accepts workflow-defined custom roles', async () => {
    const seen: unknown[] = []
    await runTaskCreateCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--role',
        'collector:larry',
        '--idempotency-key',
        'cli:create:role',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify(taskResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      roleBindings: { collector: { kind: 'agent', id: 'larry' } },
    })
  })

  test('passes supervisor fields and CSV capabilities', async () => {
    const seen: unknown[] = []
    await runTaskCreateCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--supervisor',
        'cody',
        '--supervisor-autonomy',
        'managed',
        '--supervisor-capability',
        'review,approve',
        '--idempotency-key',
        'cli:create:supervisor',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify(taskResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      supervisor: {
        actor: { kind: 'agent', id: 'cody' },
        autonomy: 'managed',
        capabilities: { review: true, approve: true },
      },
    })
  })
})
