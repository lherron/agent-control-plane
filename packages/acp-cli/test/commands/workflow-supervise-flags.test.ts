import { describe, expect, test } from 'bun:test'

import { runWorkflowSuperviseCommand } from '../../src/commands/workflow-supervise.js'
import { runCli } from '../cli-test-helpers.js'

function superviseResponse() {
  return {
    task: {
      taskId: 'T-CUSTOM',
      state: { status: 'open', phase: 'todo' },
      version: 0,
    },
    supervisorRun: { runId: 'sup_1', contextHash: 'sha256:context' },
    context: {},
  }
}

describe('workflow supervise flag alignment', () => {
  test('passes --task-id in createTask mode and parses supervisor capabilities CSV', async () => {
    const seen: unknown[] = []
    await runWorkflowSuperviseCommand(
      [
        '--server',
        'http://acp.test',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--task-id',
        'T-CUSTOM',
        '--supervisor',
        'agent:cody',
        '--supervisor-capability',
        'review,approve',
        '--idempotency-key',
        'cli:supervise',
        '--json',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify(superviseResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      capabilities: { review: true, approve: true },
      createTask: { taskId: 'T-CUSTOM' },
    })
  })

  test('accepts canonical --bind and compat --role together', async () => {
    const seen: unknown[] = []
    await runWorkflowSuperviseCommand(
      [
        '--server',
        'http://acp.test',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--supervisor',
        'cody',
        '--bind',
        'collector=agent:larry',
        '--role',
        'reviewer:curly',
        '--idempotency-key',
        'cli:supervise:roles',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify(superviseResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      createTask: {
        roleBindings: {
          collector: { kind: 'agent', id: 'larry' },
          reviewer: { kind: 'agent', id: 'curly' },
        },
      },
    })
  })

  test('top-level acp supervise accepts --task-id and --supervisor-capability', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'supervise',
        '--workflow',
        'basic@1',
        '--project',
        'P-1',
        '--goal',
        'collect evidence',
        '--task-id',
        'T-CUSTOM',
        '--supervisor',
        'cody',
        '--supervisor-capability',
        'review',
        '--idempotency-key',
        'cli:supervise:top',
        '--json',
      ],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify(superviseResponse()), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      }
    )

    expect(result.exitCode).toBe(0)
  })
})
