import { describe, expect, test } from 'bun:test'
import type { JobFlow } from 'acp-core'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { agentStep, createJobRun, withFlowHarness } from '../fixtures/flow-engine.js'

// hrc-stale-tty-reap.v1 falls back to counting stale terminal runtimes when the
// HRC client has no probe capability. An hrcpty seat (T-12046) is a terminal
// runtime just as a tmux one is; a headless or sdk runtime is not.
const flow: JobFlow = {
  sequence: [
    {
      id: 'stale',
      kind: 'probe',
      probe: { name: 'hrc-stale-tty-reap.v1' },
      branches: { outcome: { idle: 'succeed', work: 'reap' } },
    },
    agentStep('reap', 'Reap the stale TTY runtimes.'),
  ],
}

async function probeOutcome(staleTransports: readonly string[]): Promise<unknown> {
  let outcome: unknown
  await withFlowHarness(async ({ deps, jobsStore }) => {
    const job = jobsStore.createJob({
      agentId: 'cody',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:cody:project:agent-control-plane:task:stale-tty',
      laneRef: 'main',
      schedule: { cron: '0 * * * *' },
      input: { content: 'unused' },
      flow,
      disabled: false,
      createdAt: '2026-10-29T12:00:00.000Z',
    }).job
    const jobRun = createJobRun(jobsStore, job.jobId)
    const listed: unknown[] = []
    await advanceJobFlow({
      deps: {
        ...deps,
        hrcClient: {
          listRuntimes: async (query: unknown) => {
            listed.push(query)
            return staleTransports.map((transport, index) => ({
              runtimeId: `rt-${index}`,
              transport,
            }))
          },
        } as never,
      } as never,
      job,
      jobRun,
      actor: { kind: 'system', id: 'flow-engine-test' },
      now: '2026-10-29T12:01:00.000Z',
    })
    expect(listed).toEqual([{ stale: true }])
    const step = jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'stale', 1).jobStepRun
    outcome = (step?.result as { outcome?: unknown } | undefined)?.outcome
  })
  return outcome
}

describe('hrc-stale-tty-reap.v1 listRuntimes fallback', () => {
  test('a stale hrcpty runtime is work', async () => {
    expect(await probeOutcome(['headless', 'hrcpty'])).toBe('work')
  })

  test('a stale tmux runtime is work', async () => {
    expect(await probeOutcome(['tmux'])).toBe('work')
  })

  test('only headless and sdk stale runtimes are idle', async () => {
    expect(await probeOutcome(['headless', 'sdk'])).toBe('idle')
  })
})
