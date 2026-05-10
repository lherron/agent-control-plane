import { describe, expect, test } from 'bun:test'

import { runTaskRunCommand } from '../../src/commands/task-run.js'
import { runCli } from '../cli-test-helpers.js'

const owner = { kind: 'agent', id: 'larry' } as const

describe('acp task run command', () => {
  test('launches a participant run with task, role, agent, harness, and idempotency key', async () => {
    const seen: Array<{ url: string; body: unknown; actorHeader: string | null }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        actorHeader: headers.get('x-acp-actor-agent-id'),
      })
      return new Response(
        JSON.stringify({
          participantRun: {
            runId: 'run_owner_1',
            kind: 'participant',
            taskId: 'T-12345',
            role: 'owner',
            actor: owner,
            status: 'launched',
            taskVersionAtStart: 0,
            contextHash: 'sha256:context',
            createdAt: '2026-05-09T12:00:00.000Z',
          },
          context: {
            contextHash: 'sha256:context',
            task: { id: 'T-12345', version: 0 },
            run: { id: 'run_owner_1', actor: owner, role: 'owner' },
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runTaskRunCommand(
      [
        '--server',
        'http://acp.test',
        '--task',
        'T-12345',
        '--role',
        'owner',
        '--agent',
        'larry',
        '--harness',
        'codex',
        '--idempotency-key',
        'cli:participant:start',
        '--json',
      ],
      { fetchImpl }
    )

    expect(seen).toEqual([
      {
        url: 'http://acp.test/v1/workflow-participant-runs',
        actorHeader: 'larry',
        body: {
          taskId: 'T-12345',
          role: 'owner',
          actor: owner,
          harness: { kind: 'codex' },
          idempotencyKey: 'cli:participant:start',
        },
      },
    ])
    expect(output).toEqual({
      format: 'json',
      body: expect.objectContaining({
        participantRun: expect.objectContaining({
          runId: 'run_owner_1',
          status: 'launched',
          contextHash: 'sha256:context',
        }),
        context: expect.objectContaining({ contextHash: 'sha256:context' }),
      }),
    })
  })

  test('--resume requests the existing participant run and returns the recompiled context', async () => {
    const seen: Array<{ body: unknown }> = []
    const fetchImpl = async (_input: Request | string | URL, init?: RequestInit) => {
      seen.push({ body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify({
          participantRun: {
            runId: 'run_owner_existing',
            kind: 'participant',
            taskId: 'T-12345',
            role: 'owner',
            actor: owner,
            status: 'running',
            taskVersionAtStart: 0,
            contextHash: 'sha256:recompiled',
            createdAt: '2026-05-09T12:00:00.000Z',
          },
          context: {
            contextHash: 'sha256:recompiled',
            task: { id: 'T-12345', version: 2 },
            run: { id: 'run_owner_existing', actor: owner, role: 'owner' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runTaskRunCommand(
      [
        '--server',
        'http://acp.test',
        '--task',
        'T-12345',
        '--role',
        'owner',
        '--agent',
        'larry',
        '--resume',
        '--json',
      ],
      { fetchImpl }
    )

    expect(seen).toEqual([
      {
        body: {
          taskId: 'T-12345',
          role: 'owner',
          actor: owner,
          resume: true,
        },
      },
    ])
    expect(output.body).toMatchObject({
      participantRun: { runId: 'run_owner_existing', status: 'running' },
      context: { contextHash: 'sha256:recompiled', task: { version: 2 } },
    })
  })

  test('renders text output with run id, status, and context hash', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          participantRun: {
            runId: 'run_owner_1',
            kind: 'participant',
            taskId: 'T-12345',
            role: 'owner',
            actor: owner,
            status: 'launched',
            taskVersionAtStart: 0,
            contextHash: 'sha256:context',
            createdAt: '2026-05-09T12:00:00.000Z',
          },
          context: { contextHash: 'sha256:context', task: { id: 'T-12345', version: 0 } },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )

    const output = await runTaskRunCommand(
      [
        '--server',
        'http://acp.test',
        '--task',
        'T-12345',
        '--role',
        'owner',
        '--agent',
        'larry',
        '--idempotency-key',
        'cli:participant:start:text',
      ],
      { fetchImpl }
    )

    expect(output).toEqual({
      format: 'text',
      text: expect.stringContaining(
        'Started participant run run_owner_1 for T-12345 owner; status=launched context=sha256:context'
      ),
    })
  })

  test('requires --task', async () => {
    await expect(
      runTaskRunCommand(['--role', 'owner', '--agent', 'larry'])
    ).rejects.toThrow('--task is required')
  })

  test('is registered under acp task run', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'task',
        'run',
        '--task',
        'T-12345',
        '--role',
        'owner',
        '--agent',
        'larry',
        '--json',
      ],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              participantRun: {
                runId: 'run_owner_1',
                kind: 'participant',
                taskId: 'T-12345',
                role: 'owner',
                actor: owner,
                status: 'launched',
                taskVersionAtStart: 0,
                contextHash: 'sha256:context',
                createdAt: '2026-05-09T12:00:00.000Z',
              },
              context: { contextHash: 'sha256:context', task: { id: 'T-12345', version: 0 } },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          ),
      }
    )

    expect(result.exitCode).toBe(0)
  })
})
