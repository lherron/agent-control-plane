import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { type JobRecord, createInMemoryJobsStore } from 'acp-jobs-store'

import type { Actor } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../../src/deps.js'
import { handleCreateAdminJob, handlePatchAdminJob } from '../../src/handlers/admin-jobs.js'
import { errorResponse } from '../../src/http.js'
import { createUnassignedScheduleReporter } from '../../src/jobs/execution-status.js'
import { formatJobIdentityMissedTickDiagnostic } from '../../src/jobs/node-identity.js'
import { applyPlanWithStores } from '../../src/resources/apply.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }
type Mode = 'single-node' | 'federated'

function depsFor(mode: Mode, jobsStore = createInMemoryJobsStore()) {
  const identity = { nodeId: 'max3', mode }
  return {
    jobsStore,
    deps: {
      jobsStore,
      adminStore: createInMemoryAdminStore(),
      defaultActor: ACTOR,
      jobNodeIdentityAuthority: {
        getDiagnostics: () => ({
          startupState: 'ready' as const,
          baseline: identity,
          current: identity,
          quiesced: false,
        }),
      },
    } as unknown as ResolvedAcpServerDeps,
  }
}

async function call(
  handler: typeof handleCreateAdminJob,
  deps: ResolvedAcpServerDeps,
  body: Record<string, unknown>,
  params: Record<string, string> = {}
): Promise<Response> {
  try {
    return await handler({
      request: new Request('http://acp.local/v1/admin/jobs', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      url: new URL('http://acp.local/v1/admin/jobs'),
      params,
      deps,
      actor: ACTOR,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

const SCHEDULE_BODY = {
  agentId: 'cody',
  projectId: 'archagent',
  scopeRef: 'agent:cody:project:archagent:task:ae-verify-only',
  schedule: { cron: '40 8 * * *' },
  input: { content: 'nightly' },
}

function planWith(execution: Record<string, unknown> | undefined, disabled = false) {
  const ownerScopeRef = 'agent:cody:project:archagent'
  return {
    schema: 'agent-authored-runtime-resources.plan/v1',
    sourceOwnerScopeRef: ownerScopeRef,
    resources: [
      {
        projectionId: 'agent-directory:agent:cody:project:archagent:scheduled-job:nightly',
        projectionPk: 'agent-cody.nightly',
        sourceOwnerScopeRef: ownerScopeRef,
        resourceName: 'nightly',
        resourceKind: 'scheduled-job',
        sourcePath: 'schedules/nightly.toml',
        sourceHash: `sha256-canonical-json/v1:${'b'.repeat(64)}`,
        desiredProjectionHash: `sha256-canonical-json/v1:${'a'.repeat(64)}`,
        desiredJson: {
          kind: 'scheduled-job',
          slug: 'agent-cody.nightly',
          projectId: 'archagent',
          agentId: 'cody',
          scopeRef: 'agent:cody:project:archagent:task:nightly',
          laneRef: 'main',
          disabled,
          trigger: { kind: 'schedule' },
          schedule: { cron: '40 8 * * *' },
          ...(execution !== undefined ? { execution } : {}),
          input: { content: 'nightly' },
        },
      },
    ],
  }
}

describe('schedules without an execution owner in federated mode', () => {
  test('job create refuses an enabled unowned schedule in federated mode only', async () => {
    const federated = depsFor('federated')
    const refused = await call(handleCreateAdminJob, federated.deps, SCHEDULE_BODY)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'job_execution_unassigned_federated'
    )
    expect(federated.jobsStore.listJobs().jobs).toHaveLength(0)

    const disabled = await call(handleCreateAdminJob, federated.deps, {
      ...SCHEDULE_BODY,
      disabled: true,
    })
    expect(disabled.status).toBe(201)

    const single = depsFor('single-node')
    expect((await call(handleCreateAdminJob, single.deps, SCHEDULE_BODY)).status).toBe(201)
  })

  test('job patch refuses to re-enable an unowned schedule in federated mode', async () => {
    const { deps, jobsStore } = depsFor('federated')
    const job = jobsStore.createJob({ ...SCHEDULE_BODY, disabled: true }).job
    const response = await call(
      handlePatchAdminJob,
      deps,
      { disabled: false },
      {
        jobId: job.jobId,
      }
    )
    expect(response.status).toBe(409)
    expect(jobsStore.getJob(job.jobId).job?.disabled).toBe(true)
  })

  test('managed-resource apply fails an enabled unowned scheduled-job in federated mode', async () => {
    const { jobsStore, deps } = depsFor('federated')
    const refused = await applyPlanWithStores({
      plan: planWith(undefined) as never,
      jobsStore,
      interfaceStore: undefined as never,
      now: '2026-10-04T00:00:00.000Z',
      executionMode: 'federated',
    })
    expect(refused.stats.failed).toBe(1)
    expect(refused.outcomes[0]?.error?.code).toBe('UNASSIGNED_FEDERATED_SCHEDULE')
    expect(jobsStore.listJobs().jobs).toHaveLength(0)

    const owned = await applyPlanWithStores({
      plan: planWith({ nodes: ['max3'] }) as never,
      jobsStore,
      interfaceStore: undefined as never,
      now: '2026-10-04T00:00:00.000Z',
      executionMode: 'federated',
    })
    expect(owned.stats.created).toBe(1)
    void deps
  })

  test('the tick reporter logs unowned schedules on first sight and at the repeat interval, never wrong-node', () => {
    const lines: string[] = []
    let now = Date.parse('2026-10-04T00:00:00.000Z')
    const report = createUnassignedScheduleReporter({
      log: (line) => lines.push(line),
      now: () => now,
      repeatMs: 60_000,
    })
    const job = { jobId: 'job_1', slug: 'agent-cody.nightly' } as JobRecord
    report({ job, code: 'job_execution_wrong_node' })
    expect(lines).toHaveLength(0)
    report({ job, code: 'job_execution_unassigned_federated' })
    report({ job, code: 'job_execution_unassigned_federated' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('agent-cody.nightly')
    expect(lines[0]).toContain('job_1')
    now += 60_000
    report({ job, code: 'job_execution_unassigned_federated' })
    expect(lines).toHaveLength(2)
  })

  test('the missed-tick diagnostic names due schedules that have no execution owner', () => {
    const store = createInMemoryJobsStore()
    try {
      store.createJob({
        ...SCHEDULE_BODY,
        slug: 'agent-cody.nightly',
        createdAt: '2026-07-01T00:00:00.000Z',
      })
      const diagnostic = formatJobIdentityMissedTickDiagnostic(
        store,
        { ok: false, code: 'hrc_identity_unavailable', message: 'down' },
        new Date('2026-10-04T00:00:00.000Z')
      )
      expect(diagnostic).toContain('no-execution-owner=1 [agent-cody.nightly]')
    } finally {
      store.close()
    }
  })
})
