import { describe, expect, test } from 'bun:test'
import type { JobFlow } from 'acp-core'
import {
  type FlowEngineDeps,
  type JobsStore,
  advanceCreatedFlow,
  agentStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

// Characterization (T-12460): a probe that cannot run fails its step with a
// typed error code, and the unbranched failure fails the job with that code.
function probeFlow(name: string): JobFlow {
  return {
    sequence: [
      {
        id: 'gate',
        kind: 'probe',
        probe: { name },
        branches: { outcome: { idle: 'succeed', work: 'act' } },
      },
      agentStep('act', 'must not dispatch after a failed probe'),
    ],
  }
}

async function runProbe(
  name: string,
  overrideDeps: (deps: FlowEngineDeps) => FlowEngineDeps
): Promise<{ step: unknown; job: { status: string; errorCode?: string; errorMessage?: string } }> {
  return withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
    const { jobRun, advanced } = await advanceCreatedFlow({
      deps: overrideDeps(deps),
      jobsStore: jobsStore as JobsStore,
      flow: probeFlow(name),
    })
    expect(inputAttemptStore.calls).toHaveLength(0)
    return {
      step: jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'gate', 1).jobStepRun,
      job: advanced,
    }
  })
}

describe('advanceJobFlow probe step failures', () => {
  test('hrc-stale-tty-reap.v1 without an HRC client fails probe_unavailable', async () => {
    const { step, job } = await runProbe('hrc-stale-tty-reap.v1', (deps) => ({
      ...deps,
      hrcClient: undefined,
    }))

    expect(step).toMatchObject({
      status: 'failed',
      error: {
        code: 'probe_unavailable',
        message: 'hrcClient probe capability is not configured',
      },
      completedAt: '2026-04-28T12:01:00.000Z',
    })
    expect(job).toMatchObject({
      status: 'failed',
      errorCode: 'probe_unavailable',
      errorMessage: 'hrcClient probe capability is not configured',
    })
  })

  test('an HRC probe returning an unknown outcome fails invalid_probe_outcome', async () => {
    const probeCalls: unknown[] = []
    const { step, job } = await runProbe('hrc-stale-tty-reap.v1', (deps) => ({
      ...deps,
      hrcClient: {
        probe: async (input: unknown) => {
          probeCalls.push(input)
          return { outcome: 'maybe' }
        },
      } as never,
    }))

    expect(probeCalls).toEqual([
      expect.objectContaining({
        name: 'hrc-stale-tty-reap.v1',
        phase: 'sequence',
        stepId: 'gate',
        laneRef: 'main',
      }),
    ])
    expect(step).toMatchObject({
      status: 'failed',
      error: {
        code: 'invalid_probe_outcome',
        message: 'probe hrc-stale-tty-reap.v1 returned invalid outcome: maybe',
      },
    })
    expect(job.errorCode).toBe('invalid_probe_outcome')
  })

  test('an HRC probe that throws fails probe_failed with its message', async () => {
    const { step, job } = await runProbe('hrc-stale-tty-reap.v1', (deps) => ({
      ...deps,
      hrcClient: {
        probe: async () => {
          throw new Error('hrc probe socket closed')
        },
      } as never,
    }))

    expect(step).toMatchObject({
      status: 'failed',
      error: { code: 'probe_failed', message: 'hrc probe socket closed' },
    })
    expect(job.errorCode).toBe('probe_failed')
  })

  test('wrkq-refactor-eligible.v1 without a work client fails probe_unavailable', async () => {
    const { step, job } = await runProbe('wrkq-refactor-eligible.v1', (deps) => ({
      ...deps,
      workClient: undefined,
    }))

    expect(step).toMatchObject({
      status: 'failed',
      error: { code: 'probe_unavailable', message: 'wrkq client is not configured' },
    })
    expect(job.errorCode).toBe('probe_unavailable')
  })
})
