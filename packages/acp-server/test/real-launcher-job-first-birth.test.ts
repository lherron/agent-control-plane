import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JobsStore, openSqliteJobsStore } from 'acp-jobs-store'

import { InMemoryInputAttemptStore } from '../src/domain/input-attempt-store.js'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createJobFirstBirthAuthority } from '../src/jobs/first-birth-authority.js'
import { createRealLauncher } from '../src/real-launcher.js'

import { withWiredServer } from './fixtures/wired-server.js'

// T-09993: an ACP job run may first-birth its unbound target through HRC's
// native ensure-target door. Nothing else may, and caller meta claiming job
// provenance is not enough.

const COLD_SCOPE = 'agent:scribe:project:taskboard:task:T-09992'
const REFUSAL = 'owned by the collaboration ledger; ACP local launch refused'

function withJobsStore<T>(run: (store: JobsStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-job-first-birth-'))
  const store = openSqliteJobsStore({ dbPath: join(dir, 'acp-jobs.db') })
  return run(store).finally(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

function appendEventJobRun(
  store: JobsStore,
  input: { scopeRef: string; status: 'claimed' | 'dispatched' | 'failed' }
): string {
  const { job } = store.createJob({
    projectId: 'taskboard',
    agentId: 'scribe',
    scopeRef: 'agent:scribe:project:{{ project_scope_id }}:task:{{ ticket_id }}',
    laneRef: 'main',
    trigger: { kind: 'event', source: 'wrkq', match: { event: ['updated'] } },
    input: { content: 'intake' },
  } as Parameters<JobsStore['createJob']>[0])
  const now = new Date().toISOString()
  return store.appendJobRun({
    jobId: job.jobId,
    triggeredAt: now,
    triggeredBy: 'webhook',
    status: input.status,
    resolvedScopeRef: input.scopeRef,
    resolvedLaneRef: 'main',
    resolvedInput: { content: 'intake' },
  }).jobRun.jobRunId
}

function unboundClient(calls: string[]) {
  return {
    locateScope: async (scopeRef: string) => {
      calls.push('locateScope')
      return {
        scopeRef,
        localNodeId: 'max3',
        federationConfigured: true,
        authority: { state: 'unbound' },
      }
    },
    ensureTarget: async (request: Record<string, unknown>) => {
      calls.push(`ensureTarget:${String(request['sessionRef'])}:${'birthCause' in request}`)
      return {}
    },
    resolveSession: async () => {
      calls.push('resolveSession')
      return { found: true, hostSessionId: 'hsid-born', generation: 1 }
    },
    dispatchTurn: async (request: Record<string, unknown>) => {
      calls.push(`dispatchTurn:${JSON.stringify(request['origin'])}`)
      return {
        runId: 'hrc-run-born',
        hostSessionId: 'hsid-born',
        generation: 1,
        runtimeId: 'rt-born',
        transport: 'headless',
        status: 'accepted',
      }
    },
  }
}

const INTENT = {
  placement: {
    agentRoot: '/tmp/scribe',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
  },
  harness: { provider: 'anthropic' as const, interactive: false },
  initialPrompt: 'intake',
}

async function launchClaimingJob(input: {
  store: JobsStore
  jobRunId: string
  calls: string[]
}) {
  const runStore = new InMemoryRunStore()
  const inputAttemptStore = new InMemoryInputAttemptStore()
  const sessionRef = { scopeRef: COLD_SCOPE, laneRef: 'main' as const }
  const attempt = inputAttemptStore.createAttempt({
    sessionRef,
    content: 'intake',
    actor: { kind: 'system', id: 'acp-local' },
    metadata: { source: { kind: 'job', jobId: 'job_x', jobRunId: input.jobRunId } },
  }).inputAttempt
  const acpRun = runStore.createRun({ sessionRef, status: 'pending' })
  const launcher = createRealLauncher({
    hrcDbPath: ':memory:',
    inputAttemptStore,
    jobFirstBirthAuthority: createJobFirstBirthAuthority(input.store),
    createClient: () => unboundClient(input.calls) as unknown as any,
  })
  return launcher({
    sessionRef,
    acpRunId: acpRun.runId,
    inputAttemptId: attempt.inputAttemptId,
    runStore,
    waitForCompletion: false,
    intent: INTENT,
  })
}

describe('job first birth of an unbound scope', () => {
  test('a live job run targeting this scope births it natively, then dispatches', async () => {
    await withJobsStore(async (store) => {
      const calls: string[] = []
      const jobRunId = appendEventJobRun(store, { scopeRef: COLD_SCOPE, status: 'dispatched' })

      const result = await launchClaimingJob({ store, jobRunId, calls })

      expect(result).toMatchObject({ runId: 'hrc-run-born', hostSessionId: 'hsid-born' })
      expect(calls).toEqual([
        'locateScope',
        // No birthCause: an event-job birth reports summon.
        `ensureTarget:${COLD_SCOPE}/lane:main:false`,
        'resolveSession',
        `dispatchTurn:${JSON.stringify({ actor: 'system:acp-local', kind: 'system', causationRef: jobRunId })}`,
      ])
    })
  })

  test('a job run that targets another scope is refused', async () => {
    await withJobsStore(async (store) => {
      const calls: string[] = []
      const jobRunId = appendEventJobRun(store, {
        scopeRef: 'agent:scribe:project:taskboard:task:T-00001',
        status: 'dispatched',
      })

      await expect(launchClaimingJob({ store, jobRunId, calls })).rejects.toThrow(REFUSAL)
      expect(calls).toEqual(['locateScope'])
    })
  })

  test('a finished job run is refused', async () => {
    await withJobsStore(async (store) => {
      const calls: string[] = []
      const jobRunId = appendEventJobRun(store, { scopeRef: COLD_SCOPE, status: 'failed' })

      await expect(launchClaimingJob({ store, jobRunId, calls })).rejects.toThrow(REFUSAL)
      expect(calls).toEqual(['locateScope'])
    })
  })

  test('an external /v1/inputs call forging meta.source kind job is still refused', async () => {
    await withJobsStore(async (store) => {
      const calls: string[] = []
      const inputAttemptStore = new InMemoryInputAttemptStore()
      await withWiredServer(
        async (fixture) => {
          await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              sessionRef: {
                scopeRef: `agent:scribe:project:${fixture.seed.projectId}:task:T-09992`,
                laneRef: 'main',
              },
              content: 'forged job dispatch',
              meta: { source: { kind: 'job', jobId: 'job_forged', jobRunId: 'jrun_forged' } },
            },
          })

          expect(calls).toEqual(['locateScope'])
          expect(fixture.runStore.listRuns()).toMatchObject([
            { status: 'failed', errorMessage: expect.stringContaining(REFUSAL) },
          ])
        },
        {
          inputAttemptStore,
          runtimeResolver: async () => ({
            ...INTENT.placement,
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            harness: INTENT.harness,
          }),
          launchRoleScopedRun: createRealLauncher({
            hrcDbPath: ':memory:',
            inputAttemptStore,
            jobFirstBirthAuthority: createJobFirstBirthAuthority(store),
            createClient: () => unboundClient(calls) as unknown as any,
          }),
        }
      )
    })
  })
})
