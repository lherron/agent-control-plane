import { describe, expect, test } from 'bun:test'

import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'
import { runCli } from '../cli-test-helpers.js'

type RecordedRequest = { url: string; method: string | undefined; body: unknown }

function recordingFetch(responseBody: unknown, status = 200) {
  const requests: RecordedRequest[] = []
  const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, fetchImpl }
}

const workflowTask = {
  taskId: 'T-12345',
  projectId: 'P-00001',
  workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
  version: 2,
  goal: 'demo',
  roleBindings: { owner: { kind: 'agent', id: 'larry' } },
  createdAt: '2026-05-09T00:00:00.000Z',
  updatedAt: '2026-05-09T00:00:00.000Z',
}

const transitionResponse = {
  task: { ...workflowTask, state: { status: 'closed', outcome: 'success' } },
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

const transitionArgs = [
  '--server',
  'http://acp.test',
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
]

describe('workflow task commands', () => {
  test('--evidence kind=ref is posted as inlineEvidence on the transition request', async () => {
    const { requests, fetchImpl } = recordingFetch(transitionResponse)

    const output = await runTaskTransitionCommand(
      [...transitionArgs, '--evidence', 'completion_note=artifact://done'],
      { fetchImpl }
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/transitions')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toMatchObject({
      transitionId: 'close_success',
      role: 'owner',
      expectedTaskVersion: 1,
      inlineEvidence: [{ kind: 'completion_note', ref: 'artifact://done' }],
      idempotencyKey: 'cli:transition',
    })
    expect(output).toMatchObject({ text: expect.stringContaining('Transitioned T-12345') })
  })

  test('repeated --evidence-ref values are posted as evidenceRefs in order', async () => {
    const { requests, fetchImpl } = recordingFetch(transitionResponse)

    const output = await runTaskTransitionCommand(
      [...transitionArgs, '--evidence-ref', 'evd_1', '--evidence-ref', 'evd_2'],
      { fetchImpl }
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/transitions')
    expect(requests[0]?.body).toMatchObject({
      transitionId: 'close_success',
      role: 'owner',
      expectedTaskVersion: 1,
      evidenceRefs: ['evd_1', 'evd_2'],
      idempotencyKey: 'cli:transition',
    })
    expect(requests[0]?.body).not.toHaveProperty('inlineEvidence')
    expect(output).toMatchObject({ text: expect.stringContaining('Transitioned T-12345') })
  })

  test('task show fetches the task and renders its workflow id and version', async () => {
    const { requests, fetchImpl } = recordingFetch({
      source: 'wrkf',
      task: { ...workflowTask, version: 1, state: { status: 'active', phase: 'doing' } },
      instance: { revision: 1 },
      next: { transitions: [] },
      timeline: [],
      evidence: [],
      obligations: [],
      effects: [],
      runs: [],
    })

    const result = await runCli(
      ['--server', 'http://acp.test', 'task', 'show', '--task', 'T-12345'],
      {
        fetchImpl,
      }
    )

    expect(result.exitCode).toBe(0)
    expect(requests).toEqual([
      { url: 'http://acp.test/v1/tasks/T-12345', method: 'GET', body: undefined },
    ])
    expect(result.stdout).toContain('Workflow: basic@1')
  })
})
