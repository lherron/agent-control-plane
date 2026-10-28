import { describe, expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'
import type { JobFlow } from 'acp-core'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  type JobsStore,
  agentStep,
  createJobRun,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

type FakeWrkqEligibilityTask = {
  id: string
  path: string
  state: string
  kind?: string | undefined
}

function createFakeWrkqEligibilityClient(
  tasks: readonly FakeWrkqEligibilityTask[],
  calls: Array<Record<string, unknown>>
): WorkClient {
  return {
    wrkq: {
      task: {
        async list(params: Record<string, unknown> = {}) {
          calls.push(params)
          const path = typeof params['path'] === 'string' ? params['path'] : undefined
          const rawState = params['state']
          const states =
            typeof rawState === 'string'
              ? [rawState]
              : Array.isArray(rawState)
                ? rawState.filter((value): value is string => typeof value === 'string')
                : []
          const rawKind = params['kind']
          const kinds =
            typeof rawKind === 'string'
              ? [rawKind]
              : Array.isArray(rawKind)
                ? rawKind.filter((value): value is string => typeof value === 'string')
                : []

          return {
            items: tasks.filter((task) => {
              const pathMatches =
                path === undefined || task.path === path || task.path.startsWith(`${path}/`)
              const stateMatches = states.length === 0 || states.includes(task.state)
              const kindMatches =
                kinds.length === 0 || (task.kind !== undefined && kinds.includes(task.kind))
              return pathMatches && stateMatches && kindMatches
            }),
          }
        },
      },
    },
  } as unknown as WorkClient
}

function wrkqRefactorEligibilityFlow(): JobFlow {
  return {
    sequence: [
      {
        id: 'eligible',
        kind: 'probe',
        probe: { name: 'wrkq-refactor-eligible.v1' },
        branches: { outcome: { idle: 'succeed', work: 'refactor' } },
      },
      agentStep('refactor', 'Run the wrkq refactor workflow.'),
    ],
  }
}

function createRefactorEligibilityJobRun(jobsStore: JobsStore, flow: JobFlow) {
  const job = jobsStore.createJob({
    agentId: 'cody',
    projectId: 'agent-control-plane',
    scopeRef: 'agent:cody:project:agent-control-plane:task:wrkq-refactor',
    laneRef: 'main',
    schedule: { cron: '0 */2 * * *' },
    input: { content: 'legacy input must not dispatch for flow jobs' },
    flow,
    disabled: false,
    createdAt: '2026-07-02T12:00:00.000Z',
  }).job
  return { job, jobRun: createJobRun(jobsStore, job.jobId) }
}
describe('advanceJobFlow wrkq refactor eligibility probe', () => {
  test('returns idle and completes without dispatch when no open refactor-deferred task exists', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls }) => {
      const wrkqCalls: Array<Record<string, unknown>> = []
      const workClient = createFakeWrkqEligibilityClient(
        [
          {
            id: 'T-closed-refactor',
            path: 'agent-control-plane/refactor-deferred/closed',
            state: 'completed',
            kind: 'task',
          },
          {
            id: 'T-open-inbox',
            path: 'agent-control-plane/inbox/open',
            state: 'open',
            kind: 'task',
          },
        ],
        wrkqCalls
      )
      const { job, jobRun } = createRefactorEligibilityJobRun(
        jobsStore,
        wrkqRefactorEligibilityFlow()
      )

      // T-05433 RED: this probe must be answered in-process from @wrkq/client.
      // Closed tasks under refactor-deferred and open tasks outside the container
      // are negative guards; neither should dispatch the cody refactor turn.
      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          workClient,
          hrcClient: {
            probe: async () => {
              throw new Error('wrkq-refactor-eligible.v1 must not delegate to hrcClient.probe')
            },
          } as never,
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-07-02T12:01:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(wrkqCalls).toEqual([
        expect.objectContaining({
          path: 'agent-control-plane/refactor-deferred',
          state: 'open',
          kind: 'task',
        }),
      ])
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(launchCalls).toHaveLength(0)
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['eligible', 'succeeded'],
        ['refactor', 'pending'],
      ])
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'eligible', 1).jobStepRun
      ).toMatchObject({
        result: { kind: 'probe', name: 'wrkq-refactor-eligible.v1', outcome: 'idle' },
        branchTaken: { kind: 'outcome', key: 'idle', target: 'succeed' },
      })
    })
  })

  test('returns work and dispatches when an open refactor-deferred task exists', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, inputAttemptStore, launchCalls }) => {
        const wrkqCalls: Array<Record<string, unknown>> = []
        const workClient = createFakeWrkqEligibilityClient(
          [
            {
              id: 'T-open-refactor',
              path: 'agent-control-plane/refactor-deferred/ready',
              state: 'open',
              kind: 'task',
            },
          ],
          wrkqCalls
        )
        const { job, jobRun } = createRefactorEligibilityJobRun(
          jobsStore,
          wrkqRefactorEligibilityFlow()
        )

        // T-05433 RED: one open task under the refactor-deferred container is
        // sufficient eligibility and must route to the existing cody agent step.
        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            workClient,
            hrcClient: {
              probe: async () => {
                throw new Error('wrkq-refactor-eligible.v1 must not delegate to hrcClient.probe')
              },
            } as never,
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-07-02T12:01:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(wrkqCalls).toEqual([
          expect.objectContaining({
            path: 'agent-control-plane/refactor-deferred',
            state: 'open',
            kind: 'task',
          }),
        ])
        expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
          'Run the wrkq refactor workflow.',
        ])
        expect(launchCalls).toHaveLength(1)
        expect(
          jobsStore.jobStepRuns
            .listByJobRun(jobRun.jobRunId)
            .jobStepRuns.map((step) => [step.stepId, step.status])
        ).toEqual([
          ['eligible', 'succeeded'],
          ['refactor', 'succeeded'],
        ])
        expect(
          jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'eligible', 1).jobStepRun
        ).toMatchObject({
          result: { kind: 'probe', name: 'wrkq-refactor-eligible.v1', outcome: 'work' },
          branchTaken: { kind: 'outcome', key: 'work', target: 'refactor' },
        })
      },
      [{ status: 'completed', text: 'RESULT\n{}' }]
    )
  })
})
