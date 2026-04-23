import { describe, expect, test } from 'bun:test'

import { runDeliveryCommand } from '../../src/commands/delivery.js'
import { runHeartbeatCommand } from '../../src/commands/heartbeat.js'
import { runJobCommand } from '../../src/commands/job.js'
import { runJobRunCommand } from '../../src/commands/job-run.js'
import { runMessageCommand } from '../../src/commands/message.js'
import { runRenderCommand } from '../../src/commands/render.js'
import { runTailCommand } from '../../src/commands/tail.js'
import { runThreadCommand } from '../../src/commands/thread.js'
import { createFetchQueue } from '../cli-test-helpers.js'

describe('coordination and observability CLI commands', () => {
  test('message send posts one coordination message', async () => {
    const queue = createFetchQueue([
      {
        body: { messageId: 'msg_123', coordinationEventId: 'evt_123' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/coordination/messages')
          expect(request.body).toMatchObject({
            projectId: 'agent-spaces',
            from: { kind: 'agent', agentId: 'larry' },
            to: { kind: 'agent', agentId: 'clod' },
            body: 'ready',
          })
        },
      },
    ])

    const output = await runMessageCommand(
      ['send', '--project', 'agent-spaces', '--from-agent', 'larry', '--to-agent', 'clod', '--text', 'ready'],
      { fetchImpl: queue.fetchImpl }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { messageId: 'msg_123' } })
  })

  test('message broadcast fans out to multiple recipients', async () => {
    const queue = createFetchQueue([
      {
        body: { messageId: 'msg_1' },
        assert(request) {
          expect(request.body).toMatchObject({ to: { kind: 'agent', agentId: 'clod' } })
        },
      },
      {
        body: { messageId: 'msg_2' },
        assert(request) {
          expect(request.body).toMatchObject({ to: { kind: 'agent', agentId: 'rex' } })
        },
      },
    ])

    const output = await runMessageCommand(
      [
        'broadcast',
        '--project',
        'agent-spaces',
        '--from-agent',
        'larry',
        '--to-agent',
        'clod',
        '--to-agent',
        'rex',
        '--text',
        'deploying',
      ],
      { fetchImpl: queue.fetchImpl }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { results: [{ messageId: 'msg_1' }, { messageId: 'msg_2' }] } })
  })

  test('job, job-run, delivery, and thread commands hit the expected routes', async () => {
    const queue = createFetchQueue([
      {
        body: { job: { jobId: 'job_daily', projectId: 'agent-spaces' } },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs')
        },
      },
      {
        body: { jobs: [{ jobId: 'job_daily', projectId: 'agent-spaces' }] },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs')
        },
      },
      {
        body: { jobRun: { jobRunId: 'jr_123', jobId: 'job_daily' } },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs/job_daily/run')
        },
      },
      {
        body: { jobRuns: [{ jobRunId: 'jr_123', jobId: 'job_daily' }] },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/jobs/job_daily/runs')
        },
      },
      {
        body: { deliveries: [{ deliveryRequestId: 'dr_123' }], nextCursor: null },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/gateway/deliveries')
          expect(new URL(request.url).searchParams.get('status')).toBe('failed')
        },
      },
      {
        body: { delivery: { deliveryRequestId: 'dr_123' } },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/gateway/deliveries/dr_123/requeue')
        },
      },
      {
        body: { threads: [{ threadId: 'thread_123', gatewayId: 'discord' }] },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/conversation/threads')
        },
      },
      {
        body: { turns: [{ turnId: 'turn_123', role: 'assistant', renderState: 'delivered' }] },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/conversation/threads/thread_123/turns')
        },
      },
    ])

    const createOutput = await runJobCommand(
      [
        'create',
        '--project',
        'agent-spaces',
        '--agent',
        'larry',
        '--scope-ref',
        'agent:larry:project:agent-spaces',
        '--cron',
        '0 * * * *',
        '--input',
        '{"content":"status"}',
      ],
      { fetchImpl: queue.fetchImpl }
    )
    expect(createOutput).toMatchObject({ body: { job: { jobId: 'job_daily' } } })

    const listOutput = await runJobCommand(['list', '--project', 'agent-spaces'], { fetchImpl: queue.fetchImpl })
    expect(listOutput).toMatchObject({ body: { jobs: [{ jobId: 'job_daily' }] } })

    const runOutput = await runJobCommand(['run', '--job', 'job_daily'], { fetchImpl: queue.fetchImpl })
    expect(runOutput).toMatchObject({ body: { jobRun: { jobRunId: 'jr_123' } } })

    const jobRunsOutput = await runJobRunCommand(['list', '--job', 'job_daily'], { fetchImpl: queue.fetchImpl })
    expect(jobRunsOutput).toMatchObject({ body: { jobRuns: [{ jobRunId: 'jr_123' }] } })

    const failedOutput = await runDeliveryCommand(['list-failed'], { fetchImpl: queue.fetchImpl })
    expect(failedOutput).toMatchObject({ body: { deliveries: [{ deliveryRequestId: 'dr_123' }] } })

    const retryOutput = await runDeliveryCommand(['retry', '--delivery', 'dr_123', '--requeued-by', 'larry'], { fetchImpl: queue.fetchImpl })
    expect(retryOutput).toMatchObject({ body: { delivery: { deliveryRequestId: 'dr_123' } } })

    const threadListOutput = await runThreadCommand(['list'], { fetchImpl: queue.fetchImpl })
    expect(threadListOutput).toMatchObject({ body: { threads: [{ threadId: 'thread_123' }] } })

    const turnsOutput = await runThreadCommand(['turns', '--thread', 'thread_123'], { fetchImpl: queue.fetchImpl })
    expect(turnsOutput).toMatchObject({ body: { turns: [{ turnId: 'turn_123' }] } })
  })

  test('tail, render, and heartbeat commands produce usable outputs', async () => {
    const queue = createFetchQueue([
      {
        text: `${JSON.stringify({ hrcSeq: 41, eventKind: 'turn.message', hostSessionId: 'hsid-1' })}\n`,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-1/events')
        },
      },
      {
        body: { text: 'recent pane output' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-1/capture')
        },
      },
      {
        body: {
          heartbeat: {
            agentId: 'larry',
            status: 'alive',
            source: 'cli-test',
          },
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/admin/agents/larry/heartbeat')
          expect(request.method).toBe('PUT')
          expect(request.body).toEqual({ source: 'cli-test' })
        },
      },
      {
        status: 202,
        body: {
          accepted: true,
          agentId: 'larry',
          projectId: 'agent-spaces',
          wakeId: 'wake_123',
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/admin/agents/larry/heartbeat/wake')
          expect(request.method).toBe('POST')
          expect(request.body).toEqual({})
        },
      },
    ])

    const tailOutput = await runTailCommand(['--session', 'hsid-1', '--json'], { fetchImpl: queue.fetchImpl })
    expect(tailOutput).toMatchObject({ body: [{ hrcSeq: 41, eventKind: 'turn.message' }] })

    const renderOutput = await runRenderCommand(['--session', 'hsid-1'], { fetchImpl: queue.fetchImpl })
    expect(renderOutput).toMatchObject({ body: { frame: { text: 'recent pane output' } } })

    const heartbeatSetOutput = await runHeartbeatCommand(
      ['set', '--agent', 'larry', '--source', 'cli-test', '--json'],
      { fetchImpl: queue.fetchImpl }
    )
    expect(heartbeatSetOutput).toMatchObject({
      body: { heartbeat: { agentId: 'larry', source: 'cli-test' } },
    })

    const heartbeatWakeOutput = await runHeartbeatCommand(
      ['wake', '--agent', 'larry', '--reason', 'operator', '--json'],
      { fetchImpl: queue.fetchImpl }
    )
    expect(heartbeatWakeOutput).toMatchObject({
      body: { accepted: true, agentId: 'larry', wakeId: 'wake_123' },
    })
  })
})
