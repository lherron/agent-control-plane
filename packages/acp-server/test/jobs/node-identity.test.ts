import { describe, expect, test } from 'bun:test'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import {
  createJobNodeIdentityAuthority,
  formatJobIdentityMissedTickDiagnostic,
  stampLegacyJobRunsAfterIdentity,
} from '../../src/jobs/node-identity.js'

type Mode = 'single-node' | 'federated'

function status(nodeId: string, mode: Mode) {
  return { node: { nodeId, mode } }
}

function authorityWith(responses: Array<ReturnType<typeof status> | Error>, calls: string[]) {
  return createJobNodeIdentityAuthority({
    getStatus: (async (options: { includeSessions: false }) => {
      calls.push(JSON.stringify(options))
      const next = responses.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('missing fake status response')
      return next
    }) as never,
  })
}

describe('job execution HRC identity authority (T-06804)', () => {
  test('establishes a startup baseline and performs one fresh read per authorization', async () => {
    const calls: string[] = []
    const authority = authorityWith(
      [status('svc', 'federated'), status('svc', 'federated'), status('svc', 'federated')],
      calls
    )

    expect(await authority.initialize()).toMatchObject({
      ok: true,
      identity: { nodeId: 'svc', mode: 'federated' },
    })
    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: true,
      identity: { nodeId: 'svc', mode: 'federated' },
    })
    expect(await authority.verifyFresh('manual_run')).toMatchObject({
      ok: true,
      identity: { nodeId: 'svc', mode: 'federated' },
    })
    expect(calls).toEqual([
      '{"includeSessions":false}',
      '{"includeSessions":false}',
      '{"includeSessions":false}',
    ])
    expect(authority.getDiagnostics()).toMatchObject({
      startupState: 'ready',
      baseline: { nodeId: 'svc', mode: 'federated' },
      current: { nodeId: 'svc', mode: 'federated' },
      quiesced: false,
    })
  })

  test('startup identity failure never authorizes a later valid read as a new baseline', async () => {
    const authority = authorityWith([new Error('hrc down'), status('svc', 'federated')], [])

    expect(await authority.initialize()).toMatchObject({
      ok: false,
      code: 'hrc_identity_unavailable',
    })
    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: false,
      code: 'startup_identity_unavailable',
      current: { nodeId: 'svc', mode: 'federated' },
    })
    expect(authority.getDiagnostics()).toMatchObject({
      startupState: 'failed',
      quiesced: false,
    })
  })

  test('missing identity fails the current authorization without using last-known-good state', async () => {
    const authority = authorityWith(
      [status('svc', 'federated'), status('', 'federated'), status('svc', 'federated')],
      []
    )
    await authority.initialize()

    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: false,
      code: 'hrc_identity_missing',
    })
    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: true,
      identity: { nodeId: 'svc', mode: 'federated' },
    })
  })

  test('node or mode drift makes managed-job execution sticky-quiescent until restart', async () => {
    const authority = authorityWith(
      [status('svc', 'federated'), status('max3', 'federated'), status('svc', 'federated')],
      []
    )
    await authority.initialize()

    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: false,
      code: 'hrc_identity_changed',
      current: { nodeId: 'max3', mode: 'federated' },
    })
    expect(await authority.verifyFresh('manual_run')).toMatchObject({
      ok: false,
      code: 'hrc_identity_changed',
      current: { nodeId: 'svc', mode: 'federated' },
    })
    expect(authority.getDiagnostics()).toMatchObject({
      quiesced: true,
      baseline: { nodeId: 'svc', mode: 'federated' },
    })
  })

  test('mode drift also quiesces when the logical node id stays the same', async () => {
    const authority = authorityWith([status('svc', 'single-node'), status('svc', 'federated')], [])
    await authority.initialize()

    expect(await authority.verifyFresh('scheduler_tick')).toMatchObject({
      ok: false,
      code: 'hrc_identity_changed',
      current: { nodeId: 'svc', mode: 'federated' },
    })
    expect(authority.getDiagnostics().quiesced).toBe(true)
  })

  test('missing HRC client fails closed with explicit diagnostics', async () => {
    const authority = createJobNodeIdentityAuthority(undefined)

    expect(await authority.initialize()).toMatchObject({
      ok: false,
      code: 'hrc_client_unavailable',
    })
    expect(authority.getDiagnostics()).toMatchObject({
      startupState: 'failed',
      lastFailure: { code: 'hrc_client_unavailable' },
      quiesced: false,
    })
  })

  test('stamps only legacy nonterminal runs after authoritative identity succeeds', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = store.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'legacy migration' },
      }).job
      const nonterminal = store.appendJobRun({
        jobId: job.jobId,
        triggeredAt: '2026-07-23T01:00:00.000Z',
        triggeredBy: 'schedule',
        status: 'dispatched',
      }).jobRun
      const terminal = store.appendJobRun({
        jobId: job.jobId,
        triggeredAt: '2026-07-23T00:00:00.000Z',
        triggeredBy: 'schedule',
        status: 'succeeded',
        completedAt: '2026-07-23T00:01:00.000Z',
      }).jobRun

      expect(
        stampLegacyJobRunsAfterIdentity(store, {
          ok: false,
          code: 'hrc_identity_unavailable',
          message: 'HRC is unavailable',
        })
      ).toEqual({ stamped: 0 })
      expect(store.getJobRun(nonterminal.jobRunId).jobRun?.executionNodeId).toBeUndefined()

      expect(
        stampLegacyJobRunsAfterIdentity(store, {
          ok: true,
          identity: {
            nodeId: 'svc',
            mode: 'federated',
            verifiedAt: '2026-07-23T02:00:00.000Z',
          },
        })
      ).toEqual({ stamped: 1 })
      expect(store.getJobRun(nonterminal.jobRunId).jobRun?.executionNodeId).toBe('svc')
      expect(store.getJobRun(terminal.jobRunId).jobRun?.executionNodeId).toBeUndefined()
      expect(
        stampLegacyJobRunsAfterIdentity(store, {
          ok: true,
          identity: {
            nodeId: 'max3',
            mode: 'federated',
            verifiedAt: '2026-07-23T03:00:00.000Z',
          },
        })
      ).toEqual({ stamped: 0 })
      expect(store.getJobRun(nonterminal.jobRunId).jobRun?.executionNodeId).toBe('svc')
    } finally {
      store.close()
    }
  })

  test('missed-tick diagnostic distinguishes catch-up from unrecoverable schedules', () => {
    const store = createInMemoryJobsStore()
    try {
      for (const [slug, catchUp] of [
        ['catch-up', 'one'],
        ['no-catch-up', 'none'],
      ] as const) {
        store.createJob({
          slug,
          projectId: 'agent-control-plane',
          agentId: 'cody',
          scopeRef: 'agent:cody:project:agent-control-plane',
          schedule: { cron: '* * * * *', catchUp },
          input: { content: slug },
          createdAt: '2026-07-23T00:00:00.000Z',
        })
      }

      const diagnostic = formatJobIdentityMissedTickDiagnostic(
        store,
        {
          ok: false,
          code: 'hrc_identity_unavailable',
          message: 'fresh HRC status read failed',
        },
        new Date('2026-07-23T01:00:00.000Z')
      )

      expect(diagnostic).toContain('catch-up-enabled=1')
      expect(diagnostic).toContain('non-catch-up=1')
      expect(diagnostic).toContain('1 non-catch-up occurrence(s) may not be recovered')
    } finally {
      store.close()
    }
  })
})
