import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, createJobsScheduler } from 'acp-jobs-store'

import type { AcpServerDeps } from '../src/index.js'
import { advanceJobFlow } from '../src/jobs/flow-engine.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function createCompletedLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      if (input.acpRunId === undefined) {
        throw new Error('expected acpRunId for scheduled flow step')
      }

      input.runStore?.updateRun(input.acpRunId, {
        status: 'completed',
        hrcRunId: `hrc-${input.acpRunId}`,
        hostSessionId: 'hsid-scheduled-flow',
      })

      return {
        runId: `hrc-${input.acpRunId}`,
        sessionId: 'hsid-scheduled-flow',
      }
    },
  }
}

describe('jobs scheduler server wiring', () => {
  test('scheduled flow jobs advance through the flow engine instead of legacy dispatch', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []
    const launchOverrides = createCompletedLaunchOverrides(launchCalls)

    try {
      await withWiredServer(
        async (fixture) => {
          const job = jobsStore.createJob({
            agentId: 'larry',
            projectId: fixture.seed.projectId,
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01311:role:implementer`,
            laneRef: 'main',
            schedule: { cron: '*/5 * * * *' },
            input: { content: 'legacy content should not be dispatched' },
            flow: {
              sequence: [
                { id: 'collect', input: 'collect context' },
                { id: 'implement', input: 'apply change' },
              ],
            },
            disabled: false,
            createdAt: '2026-04-27T23:00:00.000Z',
          }).job

          const scheduler = createJobsScheduler({
            store: jobsStore,
            dispatchThroughInputs: async () => {
              throw new Error('legacy dispatch should not run for flow jobs')
            },
            advanceFlowJobRun: (entry) =>
              advanceJobFlow({
                deps: {
                  ...fixture,
                  ...launchOverrides,
                  jobsStore,
                  defaultActor: { kind: 'system', id: 'test' },
                  authorize: () => 'allow',
                } as never,
                job: entry.job,
                jobRun: entry.jobRun,
                now: entry.jobRun.triggeredAt,
                actor: { kind: 'system', id: 'test' },
              }),
          })

          const runs = await scheduler.tick('2026-04-27T23:05:00.000Z')

          expect(runs).toHaveLength(1)
          expect(runs[0]).toEqual(
            expect.objectContaining({
              jobId: job.jobId,
              status: 'succeeded',
            })
          )
          expect(launchCalls).toHaveLength(2)
          expect(
            jobsStore.jobStepRuns
              .listByJobRun(runs[0]!.jobRunId)
              .jobStepRuns.map((step) => [step.stepId, step.status])
          ).toEqual([
            ['collect', 'succeeded'],
            ['implement', 'succeeded'],
          ])
        },
        { jobsStore, ...launchOverrides }
      )
    } finally {
      jobsStore.close()
    }
  })
})
