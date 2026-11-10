import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAcpStateStore } from 'acp-state-store'
import type { AcpHrcClient } from '../src/deps.js'
import {
  PROTECTED_ORPHAN_RECHECK_MS,
  createStaleOrphanReaper,
} from '../src/integration/stale-orphan-reaper.js'
import {
  type HrcRouteFakeOptions,
  createHrcRouteFake,
  sessionHomeUnreachable,
} from './fixtures/hrc-route-fake.js'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const now = Date.parse('2026-11-05T02:00:00Z')
const old = '2026-06-01T00:00:00Z'
function fixture(routes: HrcRouteFakeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-orphan-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const state = openAcpStateStore({ dbPath: join(dir, 'acp.db') })
  cleanup.push(() => state.close())
  const hrc = new Database(join(dir, 'hrc.db'))
  cleanup.push(() => hrc.close())
  hrc.exec(
    'CREATE TABLE runs (run_id TEXT, runtime_id TEXT, host_session_id TEXT, scope_ref TEXT, lane_ref TEXT, status TEXT, completed_at TEXT); CREATE TABLE runtimes (runtime_id TEXT, status TEXT, host_session_id TEXT, scope_ref TEXT, lane_ref TEXT)'
  )
  let live = false
  let unavailable = false
  let duringProof = () => {}
  const client = {
    locateScope: async () => ({ authority: { state: 'bound', isLocal: true } }),
    listRuntimes: async () => {
      duringProof()
      if (unavailable) throw new Error('HRC unavailable')
      return live ? [{ runtimeId: 'rt-old', status: 'busy' }] : []
    },
  } as unknown as AcpHrcClient
  const reaperInput = {
    sqlite: state.sqlite,
    runStore: state.runs,
    inputQueueStore: state.inputQueue,
    inputAdmissionStore: state.inputAdmissions,
    hrcClient: client,
    hrc: createHrcRouteFake(join(dir, 'hrc.db'), routes),
    now: () => now,
  }
  const reaper = createStaleOrphanReaper(reaperInput)
  const sessionRef = {
    scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
    laneRef: 'main',
  }
  function seed(status: 'queued' | 'running' | 'completed' = 'queued') {
    const run = state.runs.createRun({ sessionRef, status })
    const { inputAttempt } = state.inputAttempts.createAttempt({ sessionRef, content: 'old input' })
    const queue = state.inputQueue.create({
      ...sessionRef,
      seq: state.sessionAdmissionSequences.reserve(sessionRef),
      runId: run.runId,
      inputAttemptId: inputAttempt.inputAttemptId,
      status: status === 'queued' ? 'queued' : 'running',
    })
    state.inputAdmissions.create({
      inputAttemptId: inputAttempt.inputAttemptId,
      runId: run.runId,
      queueItemId: queue.queueItemId,
      status: 'queued',
      admissionKind: 'queued_run',
      intent: { kind: 'new_work' },
      originalResponse: {},
    })
    for (const table of ['runs', 'input_queue', 'input_admissions'])
      state.sqlite.prepare(`UPDATE ${table} SET updated_at = ?, created_at = ?`).run(old, old)
    return { run, queue, inputAttempt }
  }
  return {
    state,
    hrc,
    reaper,
    reaperInput,
    seed,
    setLive: () => {
      live = true
    },
    setUnavailable: () => {
      unavailable = true
    },
    onProof: (fn: () => void) => {
      duringProof = fn
    },
  }
}

test('dry-run lists exact expiry actions without writes; cadence expires never-started work even on live seat', async () => {
  const f = fixture()
  const { run, queue, inputAttempt } = f.seed()
  f.setLive()
  const before = JSON.stringify(f.state.runs.getRun(run.runId))
  const report = await f.reaper.dryRun()
  expect(report.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: 'runs',
        id: run.runId,
        to: 'cancelled',
        reason: 'stale_never_dispatched',
      }),
      expect.objectContaining({ table: 'input_queue', id: queue.queueItemId, to: 'expired' }),
      expect.objectContaining({
        table: 'input_admissions',
        id: inputAttempt.inputAttemptId,
        to: 'failed',
      }),
    ])
  )
  expect(JSON.stringify(f.state.runs.getRun(run.runId))).toBe(before)
  await f.reaper.runOnce()
  expect(f.state.runs.getRun(run.runId)?.status).toBe('cancelled')
  expect(f.state.inputQueue.getById(queue.queueItemId)?.status).toBe('expired')
  expect((await f.reaper.dryRun()).actions).toHaveLength(0)
})

test('stranded running queue and queued admission mirror completed run without queued session head', async () => {
  const f = fixture()
  const { run, queue, inputAttempt } = f.seed('completed')
  await f.reaper.runOnce()
  expect(f.state.runs.getRun(run.runId)?.status).toBe('completed')
  expect(f.state.inputQueue.getById(queue.queueItemId)?.status).toBe('completed')
  expect(f.state.inputAdmissions.getByInputAttemptId(inputAttempt.inputAttemptId)?.status).toBe(
    'started'
  )
})

for (const protection of [
  'live-api',
  'live-db',
  'live-run',
  'live-host',
  'unavailable',
  'status-race',
  'correlation-race',
  'fresh',
  'held',
  'future',
] as const) {
  test(`protects started/queued work: ${protection}`, async () => {
    const f = fixture()
    const queued = ['fresh', 'held', 'future'].includes(protection)
    const { run, queue, inputAttempt } = f.seed(queued ? 'queued' : 'running')
    if (!queued) {
      f.state.runs.updateRun(run.runId, { runtimeId: 'rt-old' })
      f.state.sqlite.prepare('UPDATE runs SET updated_at = ?').run(old)
    }
    if (protection === 'live-api') f.setLive()
    if (protection === 'live-db')
      f.hrc.exec("INSERT INTO runtimes VALUES ('rt-old','ready',NULL,NULL,NULL)")
    if (protection === 'live-run')
      f.hrc
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,NULL)')
        .run('h-run', 'rt-old', 'hs-old', run.scopeRef, run.laneRef, 'running')
    if (protection === 'live-host') {
      // Lose runtime correlation while retaining the host-session identity.
      f.state.sqlite
        .prepare('UPDATE runs SET runtime_id = NULL, host_session_id = ?')
        .run('hs-live')
      f.hrc.exec("INSERT INTO runtimes VALUES ('rt-new','ready','hs-live',NULL,NULL)")
    }
    if (protection === 'unavailable') f.setUnavailable()
    if (protection === 'status-race')
      f.onProof(() => {
        f.state.runs.updateRun(run.runId, { status: 'completed' })
      })
    if (protection === 'correlation-race')
      f.onProof(() => {
        f.state.runs.updateRun(run.runId, { runtimeId: 'rt-new' })
        f.state.sqlite.prepare('UPDATE runs SET updated_at = ?').run(old)
      })
    if (protection === 'fresh')
      f.state.sqlite.prepare('UPDATE runs SET updated_at = ?').run(new Date(now).toISOString())
    if (protection === 'held')
      f.state.inputAdmissions.update(inputAttempt.inputAttemptId, {
        currentState: { dispatchHeld: true },
      })
    if (protection === 'future')
      f.state.inputQueue.update(queue.queueItemId, { notBeforeAt: '2027-01-01T00:00:00Z' })
    await f.reaper.runOnce()
    expect(f.state.runs.getRun(run.runId)?.errorCode).toBeUndefined()
    expect(f.state.inputQueue.getById(queue.queueItemId)?.status).toBe(
      queued ? 'queued' : 'running'
    )
  })
}

test('fails old unroutable work with dead identity while a newer scope runtime exists', async () => {
  const f = fixture()
  const { run } = f.seed('running')
  f.state.runs.updateRun(run.runId, { runtimeId: 'rt-dead' })
  f.state.sqlite.prepare('UPDATE runs SET updated_at = ?').run(old)
  f.setLive() // rt-old is a different runtime
  await f.reaper.runOnce()
  expect(f.state.runs.getRun(run.runId)).toMatchObject({
    status: 'failed',
    errorCode: 'stale_unroutable',
  })
})

// T-13243: the final corroboration reads HRC's routes. A row a selector
// should have excluded, or a 503 from the scope-keyed runs read, protects.
for (const variant of ['clear', 'stray', 'scope-503'] as const) {
  test(`scope-arm corroboration over routes: ${variant}`, async () => {
    const f = fixture(
      variant === 'stray'
        ? { ignoreNewSelectors: true }
        : variant === 'scope-503'
          ? {
              fail: (c) =>
                c.route === 'runs' && c.query['scopeRef'] !== undefined
                  ? sessionHomeUnreachable()
                  : undefined,
            }
          : {}
    )
    const { run } = f.seed('running')
    // Neither runtime nor host identity: the scope arm decides.
    f.state.sqlite.prepare('UPDATE runs SET updated_at = ?').run(old)
    // A live runtime and an open run of another scope: excluded by exact
    // scopeRef on a daemon with T-13244, returned by one without it.
    f.hrc.exec(
      "INSERT INTO runtimes VALUES ('rt-other','ready',NULL,'agent:other:project:x:task:primary','main')"
    )
    f.hrc.exec(
      "INSERT INTO runs VALUES ('h-other','rt-other',NULL,'agent:other:project:x:task:primary','main','running',NULL)"
    )
    await f.reaper.runOnce()
    if (variant === 'clear') {
      expect(f.state.runs.getRun(run.runId)).toMatchObject({
        status: 'failed',
        errorCode: 'stale_unroutable',
      })
    } else {
      expect(f.state.runs.getRun(run.runId)?.status).toBe('running')
      expect(f.state.runs.getRun(run.runId)?.errorCode).toBeUndefined()
    }
  })
}

test('unchanged foreign candidates locate once across dispatcher ticks', async () => {
  const f = fixture()
  const { run } = f.seed('running')
  let locates = 0
  const reaper = createStaleOrphanReaper({
    ...f.reaperInput,
    hrcClient: {
      ...f.reaperInput.hrcClient,
      locateScope: async () => {
        locates++
        return { authority: { state: 'bound', isLocal: false } } as Awaited<
          ReturnType<AcpHrcClient['locateScope']>
        >
      },
    },
  })
  for (let tick = 0; tick < 20; tick++) await reaper.runOnce()
  expect(f.state.runs.getRun(run.runId)?.status).toBe('running')
  expect(locates).toBe(1)
})

test('protection expires without sliding on ticks; dry-run always obtains fresh evidence', async () => {
  const f = fixture()
  const { run } = f.seed('running')
  let clock = now
  let locates = 0
  let foreign = true
  const reaper = createStaleOrphanReaper({
    ...f.reaperInput,
    now: () => clock,
    hrcClient: {
      ...f.reaperInput.hrcClient,
      locateScope: async () => {
        locates++
        return { authority: { state: 'bound', isLocal: !foreign } } as Awaited<
          ReturnType<AcpHrcClient['locateScope']>
        >
      },
    },
  })
  await reaper.runOnce()
  foreign = false
  clock += PROTECTED_ORPHAN_RECHECK_MS - 1
  await reaper.runOnce()
  expect(locates).toBe(1)
  expect((await reaper.dryRun()).actions.some((a) => a.id === run.runId)).toBe(true)
  expect(locates).toBe(2)
  await reaper.runOnce() // Dry-run does not populate or invalidate the cadence cache.
  expect(locates).toBe(2)
  clock++
  // Fresh API evidence alone cannot bypass synchronous local live evidence.
  f.hrc.exec("INSERT INTO runtimes VALUES ('rt-live','ready',NULL,NULL,NULL)")
  f.hrc.prepare('UPDATE runtimes SET scope_ref = ?, lane_ref = ?').run(run.scopeRef, run.laneRef)
  await reaper.runOnce()
  expect(locates).toBe(3)
  expect(f.state.runs.getRun(run.runId)?.status).toBe('running')
  f.hrc.exec('DELETE FROM runtimes')
  await reaper.runOnce()
  expect(locates).toBe(4) // Successful death proofs are never cached.
  expect(f.state.runs.getRun(run.runId)?.status).toBe('failed')
})

for (const changed of ['run', 'queue', 'admission'] as const) {
  test(`changed ${changed} invalidates protected proof immediately`, async () => {
    const f = fixture()
    const { run } = f.seed('running')
    let locates = 0
    const reaper = createStaleOrphanReaper({
      ...f.reaperInput,
      hrcClient: {
        ...f.reaperInput.hrcClient,
        locateScope: async () => {
          locates++
          return { authority: { state: 'unknown' } } as Awaited<
            ReturnType<AcpHrcClient['locateScope']>
          >
        },
      },
    })
    await reaper.runOnce()
    const table = { run: 'runs', queue: 'input_queue', admission: 'input_admissions' }[changed]
    f.state.sqlite.prepare(`UPDATE ${table} SET updated_at = ?`).run('2026-06-02T00:00:00Z')
    await reaper.runOnce()
    await reaper.runOnce()
    expect(locates).toBe(2)
    expect(f.state.runs.getRun(run.runId)?.status).toBe('running')
  })
}

test('queued run with already-cancelled never-dispatched queue also expires', async () => {
  const f = fixture()
  const { run, queue } = f.seed()
  f.state.inputQueue.update(queue.queueItemId, { status: 'cancelled' })
  f.state.sqlite.prepare('UPDATE input_queue SET updated_at = ?').run(old)
  await f.reaper.runOnce()
  expect(f.state.runs.getRun(run.runId)).toMatchObject({
    status: 'cancelled',
    errorCode: 'stale_never_dispatched',
  })
})

test('normal dispatcher runs cleanup before considering queued dispatch', async () => {
  const { createInputQueueDispatcher } = await import(
    '../src/integration/input-queue-dispatcher.js'
  )
  const { createInMemoryAdminStore } = await import('acp-admin-store')
  const f = fixture()
  const { run } = f.seed()
  let launches = 0
  await createInputQueueDispatcher({
    adminStore: createInMemoryAdminStore(),
    runStore: f.state.runs,
    inputQueueStore: f.state.inputQueue,
    inputAdmissionStore: f.state.inputAdmissions,
    reapStaleOrphans: f.reaper.runOnce,
    inputQueuePolicy: {},
    config: { intervalMs: 2000 },
    launchRoleScopedRun: async () => {
      launches++
    },
  }).runOnce()
  expect(launches).toBe(0)
  expect(f.state.runs.getRun(run.runId)?.status).toBe('cancelled')
})

test('jobs with deleted definitions reconcile terminal runs; abandoned claims expire; foreign runs stay fenced', async () => {
  const { createInMemoryJobsStore } = await import('acp-jobs-store')
  const jobs = createInMemoryJobsStore()
  cleanup.push(() => jobs.close())
  const f = fixture()
  const { run } = f.seed('completed')
  for (const [id, status, runId, node] of [
    ['orphan-completed', 'dispatched', run.runId, 'max3'],
    ['old-claim', 'claimed', undefined, 'max3'],
    ['foreign', 'dispatched', run.runId, 'svc'],
    ['null-node', 'dispatched', run.runId, undefined],
    ['fresh-lease', 'claimed', undefined, 'max3'],
  ] as const) {
    jobs.appendJobRun({
      jobRunId: id,
      jobId: 'deleted-definition',
      status,
      runId,
      executionNodeId: node,
      triggeredAt: old,
      triggeredBy: 'manual',
      actorStamp: 'system:test',
      ...(id === 'fresh-lease' ? { leaseExpiresAt: '2027-01-01T00:00:00Z' } : {}),
    })
  }
  jobs.sqlite.prepare('UPDATE job_runs SET updated_at = ?, created_at = ?').run(old, old)
  const reaper = createStaleOrphanReaper({
    sqlite: f.state.sqlite,
    runStore: f.state.runs,
    inputQueueStore: f.state.inputQueue,
    inputAdmissionStore: f.state.inputAdmissions,
    hrc: createHrcRouteFake('/nonexistent'),
    jobsStore: jobs,
    verifyJobNode: async () => 'max3',
    now: () => now,
  })
  const report = await reaper.dryRun()
  expect(
    report.actions
      .filter((a) => a.table === 'job_runs')
      .map((a) => a.id)
      .sort()
  ).toEqual(['old-claim', 'orphan-completed'])
  expect(jobs.getJobRun('orphan-completed').jobRun.status).toBe('dispatched')
  await reaper.runOnce()
  expect(jobs.getJobRun('orphan-completed').jobRun.status).toBe('succeeded')
  expect(jobs.getJobRun('old-claim').jobRun).toMatchObject({
    status: 'failed',
    errorCode: 'stale_never_dispatched',
  })
  expect(jobs.getJobRun('foreign').jobRun.status).toBe('dispatched')
})

for (const live of [false, true]) {
  test(`sameSessionHasActiveRun blocks own live execution but ignores reaped stale_unroutable (${live})`, async () => {
    const { createInputQueueDispatcher } = await import(
      '../src/integration/input-queue-dispatcher.js'
    )
    const { createInMemoryAdminStore } = await import('acp-admin-store')
    const { admissionRuntime } = await import('./fixtures/input-admission.js')
    const f = fixture()
    const dead = f.seed('running')
    f.state.runs.updateRun(dead.run.runId, { runtimeId: 'rt-old' })
    const fresh = f.seed('queued')
    f.state.sqlite
      .prepare('UPDATE runs SET updated_at = ?, created_at = ? WHERE run_id = ?')
      .run(new Date(now).toISOString(), new Date(now).toISOString(), fresh.run.runId)
    if (live) f.setLive()
    let launches = 0
    await createInputQueueDispatcher({
      adminStore: createInMemoryAdminStore(),
      runStore: f.state.runs,
      inputQueueStore: f.state.inputQueue,
      inputAdmissionStore: f.state.inputAdmissions,
      reapStaleOrphans: f.reaper.runOnce,
      inputQueuePolicy: {},
      config: { intervalMs: 2000 },
      runtimeResolver: async () => admissionRuntime('fettle'),
      launchRoleScopedRun: async () => {
        launches++
      },
    }).runOnce()
    expect(launches).toBe(live ? 0 : 1)
    expect(f.state.runs.getRun(dead.run.runId)?.status).toBe(live ? 'running' : 'failed')
  })
}

for (const live of [false, true]) {
  test(`stranded contribution application records ambiguous outcome only after own execution ends (${live})`, async () => {
    const f = fixture()
    const { run, inputAttempt } = f.seed('completed')
    const app = f.state.inputApplications.create({
      inputAttemptId: inputAttempt.inputAttemptId,
      targetRunId: run.runId,
      hrcRunId: 'hrc-contribution',
      runtimeId: 'rt-old',
      status: 'accepted',
    })
    f.state.sqlite.prepare('UPDATE input_applications SET updated_at = ?').run(old)
    if (live) f.setLive()
    const reaper = createStaleOrphanReaper({
      ...f.reaperInput,
      inputApplicationStore: f.state.inputApplications,
    })
    const report = await reaper.dryRun()
    expect(report.actions.filter((a) => a.table === 'input_applications')).toHaveLength(
      live ? 0 : 1
    )
    expect(f.state.inputApplications.getById(app.inputApplicationId)?.status).toBe('accepted')
    await reaper.runOnce()
    expect(f.state.inputApplications.getById(app.inputApplicationId)?.status).toBe(
      live ? 'accepted' : 'ambiguous'
    )
  })
}
