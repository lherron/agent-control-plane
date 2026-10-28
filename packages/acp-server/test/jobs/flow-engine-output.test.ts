import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  FLOW_JOB_SCOPE_REF,
  createFlowJob,
  createJobRun,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

describe('T-08575 flow output retained-evidence fence', () => {
  for (const fixture of [
    { id: 'T3b retained', origin: 'retained' as const, expectedSource: 'LIVE-OUT' },
    { id: 'T3b C ordinary origin', origin: null, expectedSource: 'OLD-REPLY' },
  ]) {
    test(`${fixture.id} supplies the correct tmux step result through default readers`, async () => {
      await withFlowHarness(async ({ deps, jobsStore, hrc }) => {
        hrc.db.exec(`
          ALTER TABLE hrc_events ADD COLUMN host_session_id TEXT;
          ALTER TABLE hrc_events ADD COLUMN scope_ref TEXT;
          ALTER TABLE hrc_events ADD COLUMN lane_ref TEXT;
          ALTER TABLE hrc_events ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT
            CHECK (evidence_origin IS NULL OR evidence_origin = 'retained');
        `)
        const insert = hrc.db.prepare(
          `INSERT INTO hrc_events (
            hrc_seq, run_id, host_session_id, scope_ref, lane_ref,
            event_kind, payload_json, evidence_origin
          ) VALUES (?, ?, 'hsid-flow-retained', ?, 'main', 'turn.message', ?, ?)`
        )
        insert.run(
          5,
          'run-live-output',
          FLOW_JOB_SCOPE_REF,
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'RESULT\n{"source":"LIVE-OUT"}' }],
            },
          }),
          null
        )
        insert.run(
          9,
          'run-historical-output',
          FLOW_JOB_SCOPE_REF,
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'RESULT\n{"source":"OLD-REPLY"}' }],
            },
          }),
          fixture.origin
        )

        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'collect',
              input: 'collect output',
              expect: { resultBlock: 'RESULT' },
            },
          ],
        })
        const run = deps.runStore.createRun({
          sessionRef: { scopeRef: job.scopeRef, laneRef: job.laneRef },
          status: 'completed',
        })
        deps.runStore.updateRun(run.runId, {
          status: 'completed',
          hostSessionId: 'hsid-flow-retained',
          generation: 1,
          transport: 'tmux',
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: `jrun_${fixture.expectedSource.toLowerCase().replace('-', '_')}`,
          status: 'dispatched',
        })
        jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
          {
            stepId: 'collect',
            status: 'running',
            attempt: 1,
            runId: run.runId,
            startedAt: '2026-04-28T12:00:00.000Z',
          },
        ])

        const advanced = await advanceJobFlow({
          deps: deps as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:01:00.000Z',
        })
        const step = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'collect',
          1
        ).jobStepRun

        expect(advanced.status).toBe('succeeded')
        expect(step?.result).toEqual({ source: fixture.expectedSource })
      })
    })
  }
})
