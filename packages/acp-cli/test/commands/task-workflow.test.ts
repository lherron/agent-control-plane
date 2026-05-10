import { describe, expect, test } from 'bun:test'

import { runTaskCreateCommand } from '../../src/commands/task-create.js'
import { runTaskShowCommand } from '../../src/commands/task-show.js'
import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'
import { runWorkflowActionCommand } from '../../src/commands/workflow-action.js'
import { runWorkflowSuperviseCommand } from '../../src/commands/workflow-supervise.js'
import { runWorkflowSupervisorContextCommand } from '../../src/commands/workflow-supervisor-context.js'
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
    listInterfaceBindings:
      overrides.listInterfaceBindings ?? (() => Promise.reject(new Error('not implemented'))),
    upsertInterfaceBinding:
      overrides.upsertInterfaceBinding ?? (() => Promise.reject(new Error('not implemented'))),
  }
}

describe('workflow task commands', () => {
  test('creates a workflow task and returns text output', async () => {
    const client = createClientDouble({
      async createTask(input) {
        expect(input.workflow).toEqual({ id: 'basic', version: 1 })
        expect(input.roleBindings).toEqual({ owner: { kind: 'agent', id: 'larry' } })
        expect(input.idempotencyKey).toBe('cli:create')
        return {
          task: {
            taskId: 'T-12345',
            projectId: 'P-00001',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'open', phase: 'todo' },
            version: 0,
            goal: input.goal,
            roleBindings: input.roleBindings,
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        }
      },
    })

    const output = await runTaskCreateCommand(
      [
        '--workflow',
        'basic@1',
        '--project',
        'P-00001',
        '--goal',
        'demo',
        '--actor',
        'tracy',
        '--role',
        'owner:larry',
        '--idempotency-key',
        'cli:create',
      ],
      { createClient: () => client }
    )

    expect(output.format).toBe('text')
    expect(output).toMatchObject({ text: expect.stringContaining('Created T-12345') })
  })

  test('rejects duplicate roles before calling the server', async () => {
    await expect(
      runTaskCreateCommand(
        [
          '--workflow',
          'basic@1',
          '--project',
          'P-00001',
          '--goal',
          'demo',
          '--actor',
          'tracy',
          '--role',
          'owner:larry',
          '--role',
          'owner:curly',
          '--idempotency-key',
          'cli:create',
        ],
        { createClient: () => createClientDouble({}) }
      )
    ).rejects.toThrow('duplicate role assignment for owner')
  })

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

  test('shows workflow task details', async () => {
    const client = createClientDouble({
      async getTask(input) {
        expect(input).toEqual({ taskId: 'T-12345' })
        return {
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
          events: [],
          evidence: [],
          obligations: [],
          effects: [],
          supervisorRuns: [],
          participantRuns: [],
          anomalies: [],
          workflowPatchProposals: [],
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

  test('submits one checked workflow supervisor action', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined; body: unknown }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        init,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return new Response(
        JSON.stringify({
          task: {
            taskId: 'T-12345',
            state: { status: 'waiting', phase: 'awaiting_customer' },
            version: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runWorkflowActionCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--task',
        'T-12345',
        '--supervisor-run',
        'agent:rex:project:agent-spaces:task:T-12345~main',
        '--action',
        '{"type":"satisfy_obligation","obligationId":"obl_1"}',
        '--expected-version',
        '1',
        '--idempotency-key',
        'rex:control:satisfy:v1',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Applied workflow action') })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/actions')
    expect(seen[0]?.init?.method).toBe('POST')
    expect(new Headers(seen[0]?.init?.headers).get('x-acp-actor-agent-id')).toBe('rex')
    expect(seen[0]?.body).toEqual({
      supervisorRunId: 'agent:rex:project:agent-spaces:task:T-12345~main',
      action: { type: 'satisfy_obligation', obligationId: 'obl_1' },
      expectedTaskVersion: 1,
      idempotencyKey: 'rex:control:satisfy:v1',
    })
  })

  test('requests workflow supervisor context for a supervisor agent', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined; body: unknown }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        init,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return new Response(JSON.stringify({ context: { task: { id: 'T-12345' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const output = await runWorkflowSupervisorContextCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--task',
        'T-12345',
        '--run',
        'agent:rex:project:agent-spaces:task:T-12345~main',
        '--capabilities',
        '{"satisfyObligations":true}',
        '--idempotency-prefix',
        'rex:ctx',
        '--json',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ format: 'json' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/supervisor-context')
    expect(new Headers(seen[0]?.init?.headers).get('x-acp-actor-agent-id')).toBe('rex')
    expect(seen[0]?.body).toEqual({
      runId: 'agent:rex:project:agent-spaces:task:T-12345~main',
      actor: { kind: 'agent', id: 'rex' },
      autonomy: 'managed',
      capabilities: { satisfyObligations: true },
      idempotencyPrefix: 'rex:ctx',
    })
  })

  test('starts a workflow supervisor run by creating a task', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined; body: unknown }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        init,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return new Response(
        JSON.stringify({
          task: {
            taskId: 'T-12345',
            state: { status: 'open', phase: 'todo' },
            version: 0,
          },
          supervisorRun: { runId: 'supv_0002', contextHash: 'sha256:ctx' },
          context: { task: { id: 'T-12345' }, contextHash: 'sha256:ctx' },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runWorkflowSuperviseCommand(
      [
        '--server',
        'http://acp.test',
        '--workflow',
        'basic@1',
        '--project',
        'agent-spaces',
        '--goal',
        'demo',
        '--supervisor',
        'agent:rex',
        '--bind',
        'owner=agent:cody',
        '--capabilities',
        '{"launchRuns":true}',
        '--idempotency-key',
        'rex:supervise:create',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Supervising T-12345') })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/workflow-supervisor-runs')
    expect(new Headers(seen[0]?.init?.headers).get('x-acp-actor-agent-id')).toBe('rex')
    expect(seen[0]?.body).toEqual({
      supervisor: { kind: 'agent', id: 'rex' },
      autonomy: 'managed',
      capabilities: { launchRuns: true },
      idempotencyKey: 'rex:supervise:create',
      createTask: {
        projectId: 'agent-spaces',
        workflow: { id: 'basic', version: 1 },
        goal: 'demo',
        roleBindings: { owner: { kind: 'agent', id: 'cody' } },
      },
    })
  })

  test('resumes a workflow supervisor run for an existing task', async () => {
    const seen: Array<{ body: unknown }> = []
    const fetchImpl = async (_input: Request | string | URL, init?: RequestInit) => {
      seen.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({
          task: {
            taskId: 'T-12345',
            state: { status: 'waiting', phase: 'awaiting_customer' },
            version: 4,
          },
          supervisorRun: { runId: 'supv-rex-1', contextHash: 'sha256:ctx' },
          context: { task: { id: 'T-12345' }, contextHash: 'sha256:ctx' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runWorkflowSuperviseCommand(
      [
        '--server',
        'http://acp.test',
        '--task',
        'T-12345',
        '--supervisor',
        'rex',
        '--run',
        'supv-rex-1',
        '--idempotency-key',
        'rex:supervise:resume',
        '--json',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ format: 'json' })
    expect(seen[0]?.body).toEqual({
      supervisor: { kind: 'agent', id: 'rex' },
      autonomy: 'managed',
      idempotencyKey: 'rex:supervise:resume',
      runId: 'supv-rex-1',
      taskId: 'T-12345',
    })
  })
})
