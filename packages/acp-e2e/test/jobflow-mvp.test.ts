import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'
import { InMemoryRunStore } from 'acp-server'

import {
  type LaunchCall,
  RecordingInputAttemptStore,
  createFlowJob,
  createHeadlessHrcDb,
  createTerminalFlowLauncher,
  getJobRun,
  runJob,
} from './fixtures/jobflow-stack.js'
import { withSeedStack } from './fixtures/seed-stack.js'

describe('JobFlow MVP e2e', () => {
  test('runs two terminal sequence steps and exposes parsed results through GET /v1/job-runs/:jobRunId', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const launchCalls: LaunchCall[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              {
                id: 'work',
                input: 'Complete the work step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'WORK_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'work', ready: true },
                },
              },
              {
                id: 'closeout',
                input: 'Complete the closeout step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'CLOSEOUT_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'closeout', ready: true },
                },
              },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('succeeded')
          expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
            ['sequence', 'work', 'succeeded'],
            ['sequence', 'closeout', 'succeeded'],
          ])
          expect(steps[0]).toMatchObject({
            attempt: 1,
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
            resultBlock: 'WORK_RESULT',
            result: { step: 'work', summary: 'work finished', ready: true },
          })
          expect(steps[1]).toMatchObject({
            attempt: 1,
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
            resultBlock: 'CLOSEOUT_RESULT',
            result: { step: 'closeout', summary: 'closeout finished', ready: true },
          })
          expect(steps[0]?.runId).not.toBe(steps[1]?.runId)
          expect(steps[0]?.inputAttemptId).not.toBe(steps[1]?.inputAttemptId)
          expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
            `jobrun:${jobRunId}:phase:sequence:step:work:attempt:1`,
            `jobrun:${jobRunId}:phase:sequence:step:closeout:attempt:1`,
          ])
          expect(launchCalls).toHaveLength(2)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          launchRoleScopedRun: createTerminalFlowLauncher(
            hrc,
            [
              {
                status: 'completed',
                text: 'WORK_RESULT\n{"step":"work","summary":"work finished","ready":true}',
              },
              {
                status: 'completed',
                text: 'CLOSEOUT_RESULT\n{"step":"closeout","summary":"closeout finished","ready":true}',
              },
            ],
            launchCalls
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('fails on missing required result field and runs onFailure when configured', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const launchCalls: LaunchCall[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              {
                id: 'work',
                input: 'Complete the work step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'WORK_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'work', ready: true },
                },
              },
              {
                id: 'closeout',
                input: 'Complete the closeout step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'CLOSEOUT_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'closeout', ready: true },
                },
              },
            ],
            onFailure: [
              {
                id: 'notify',
                input: 'Notify that the JobFlow failed.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'FAILURE_RESULT',
                  require: ['notified'],
                  equals: { notified: true },
                },
              },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('failed')
          expect(payload.jobRun.errorCode).toBe('required_result_field_missing')
          expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
            ['sequence', 'work', 'succeeded'],
            ['sequence', 'closeout', 'failed'],
            ['onFailure', 'notify', 'succeeded'],
          ])
          expect(steps[1]).toMatchObject({
            resultBlock: 'CLOSEOUT_RESULT',
            result: { step: 'closeout', ready: true },
            error: { code: 'required_result_field_missing' },
          })
          expect(steps[2]).toMatchObject({
            resultBlock: 'FAILURE_RESULT',
            result: { notified: true },
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
          })
          expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
            `jobrun:${jobRunId}:phase:sequence:step:work:attempt:1`,
            `jobrun:${jobRunId}:phase:sequence:step:closeout:attempt:1`,
            `jobrun:${jobRunId}:phase:onFailure:step:notify:attempt:1`,
          ])
          expect(launchCalls).toHaveLength(3)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          launchRoleScopedRun: createTerminalFlowLauncher(
            hrc,
            [
              {
                status: 'completed',
                text: 'WORK_RESULT\n{"step":"work","summary":"work finished","ready":true}',
              },
              {
                status: 'completed',
                text: 'CLOSEOUT_RESULT\n{"step":"closeout","ready":true}',
              },
              {
                status: 'completed',
                text: 'FAILURE_RESULT\n{"notified":true}',
              },
            ],
            launchCalls
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })
})
