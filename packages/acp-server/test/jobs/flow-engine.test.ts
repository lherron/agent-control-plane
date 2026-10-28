import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { createFlowJob, createJobRun, withFlowHarness } from '../fixtures/flow-engine.js'

describe('advanceJobFlow validation backstop', () => {
  test('runtime backstop includes shared flow validation path/code in the thrown message', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'build',
            kind: 'exec',
            exec: { argv: ['bun', 'run', 'build'] },
            branches: { default: 'missing-step' },
          },
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId)

      // T-05418: runtime remains a backstop, but it must not discard the
      // functional validator errors when an invalid flow somehow reaches fire time.
      let thrown: unknown
      try {
        await advanceJobFlow({
          deps: deps as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:01:00.000Z',
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      expect(message).toContain('invalid_flow_next')
      expect(message).toContain('flow.sequence[0].branches.default')
    })
  })
})
