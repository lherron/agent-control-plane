import { Database } from 'bun:sqlite'
import { writeLogLine } from 'acp-core'
import type { JobRunStatus, JobsStore } from 'acp-jobs-store'
import type { AcpStateStore } from 'acp-state-store'
import type { AcpHrcClient } from '../deps.js'
import type {
  InputAdmissionStore,
  InputApplicationStore,
  InputQueueStore,
} from '../domain/input-admission-stores.js'
import type { RunStore, StoredRun } from '../domain/run-store.js'
import { readSemanticMessageCorrelation } from '../domain/semantic-message-run.js'
import { admissionStatusForRunStatus } from '../input-admission/admission-status.js'
import { isUnroutableRun } from './interface-run-dispatcher.js'

export const STALE_NEVER_DISPATCHED_MS = 7 * 24 * 60 * 60_000
export const STALE_UNROUTABLE_MS = 24 * 60 * 60_000
const terminalRuns = new Set(['completed', 'failed', 'cancelled'])
const terminalQueues = new Set(['completed', 'failed', 'cancelled', 'expired'])
const deadRuntimes = new Set(['terminated', 'stale', 'crashed', 'failed', 'exited'])

export type OrphanAction = {
  table: 'runs' | 'input_queue' | 'input_admissions' | 'job_runs' | 'input_applications'
  id: string
  runId: string
  from: string
  to: string
  reason: 'stale_never_dispatched' | 'stale_unroutable' | 'stale_orphan'
  cause: string
}
type Input = {
  sqlite: Pick<AcpStateStore['sqlite'], 'prepare' | 'transaction'>
  runStore: RunStore
  inputQueueStore: InputQueueStore
  inputApplicationStore?: InputApplicationStore | undefined
  inputAdmissionStore: InputAdmissionStore
  hrcClient?: Pick<AcpHrcClient, 'locateScope' | 'listRuntimes'> | undefined
  hrcDbPath: string
  jobsStore?: Pick<JobsStore, 'sqlite' | 'updateJobRun'> | undefined
  verifyJobNode?: (() => Promise<string | undefined>) | undefined
  now?: (() => number) | undefined
}

/** One classifier serves read-only inspection and the normal dispatcher cadence. */
export function createStaleOrphanReaper(input: Input) {
  const now = input.now ?? Date.now
  const aged = (timestamp: string, bound: number) => now() - Date.parse(timestamp) > bound

  function snapshot(runId: string) {
    const run = input.runStore.getRun(runId)
    if (run === undefined) return undefined
    const queues = (
      input.sqlite.prepare('SELECT queue_item_id FROM input_queue WHERE run_id = ?').all(runId) as {
        queue_item_id: string
      }[]
    ).flatMap((row) => {
      const item = input.inputQueueStore.getById(row.queue_item_id)
      return item === undefined ? [] : [item]
    })
    const admissions = (
      input.sqlite
        .prepare('SELECT input_attempt_id FROM input_admissions WHERE run_id = ?')
        .all(runId) as { input_attempt_id: string }[]
    ).flatMap((row) => {
      const item = input.inputAdmissionStore.getByInputAttemptId(row.input_attempt_id)
      return item === undefined ? [] : [item]
    })
    return { run, queues, admissions }
  }
  type Snapshot = NonNullable<ReturnType<typeof snapshot>>

  function classify(s: Snapshot): OrphanAction[] {
    const { run, queues, admissions } = s
    const actions: OrphanAction[] = []
    let reason: OrphanAction['reason'] = 'stale_orphan'
    let cause = `project terminal run ${run.status}`
    let outcome = run.status
    if (!terminalRuns.has(run.status)) {
      if (admissions.some((a) => a.currentState?.['dispatchHeld'] === true)) return []
      if (queues.some((q) => q.notBeforeAt !== undefined && Date.parse(q.notBeforeAt) > now()))
        return []
      if (
        run.status === 'queued' &&
        aged(run.updatedAt, STALE_NEVER_DISPATCHED_MS) &&
        run.runtimeId === undefined &&
        run.hrcRunId === undefined &&
        readSemanticMessageCorrelation(run) === undefined &&
        queues.every(
          (q) =>
            ['queued', 'cancelled', 'expired'].includes(q.status) &&
            q.attempts === 0 &&
            q.leasedAt === undefined &&
            aged(q.updatedAt, STALE_NEVER_DISPATCHED_MS)
        ) &&
        admissions.every(
          (a) => a.status === 'queued' && aged(a.updatedAt, STALE_NEVER_DISPATCHED_MS)
        )
      ) {
        outcome = 'cancelled'
        reason = 'stale_never_dispatched'
        cause = 'never-started input exceeded seven-day retention'
      } else if (
        run.status === 'running' &&
        aged(run.updatedAt, STALE_UNROUTABLE_MS) &&
        isUnroutableRun(run)
      ) {
        outcome = 'failed'
        reason = 'stale_unroutable'
        cause = 'no supported completion route and own HRC execution is no longer live'
      } else return []
      actions.push({
        table: 'runs',
        id: run.runId,
        runId: run.runId,
        from: run.status,
        to: outcome,
        reason,
        cause,
      })
    }
    for (const q of queues) {
      if (terminalQueues.has(q.status) || !aged(q.updatedAt, STALE_UNROUTABLE_MS)) continue
      actions.push({
        table: 'input_queue',
        id: q.queueItemId,
        runId: run.runId,
        from: q.status,
        to: reason === 'stale_never_dispatched' ? 'expired' : outcome,
        reason,
        cause,
      })
    }
    for (const a of admissions) {
      // `started` is also the successful terminal admission projection.
      if (
        !['queued', 'pending', 'accepted'].includes(a.status) ||
        !aged(a.updatedAt, STALE_UNROUTABLE_MS)
      )
        continue
      actions.push({
        table: 'input_admissions',
        id: a.inputAttemptId,
        runId: run.runId,
        from: a.status,
        to: admissionStatusForRunStatus(outcome),
        reason,
        cause,
      })
    }
    return actions
  }

  async function proveDead(run: StoredRun): Promise<string | undefined> {
    if (input.hrcClient === undefined) return 'HRC client unavailable'
    try {
      const location = await input.hrcClient.locateScope(run.scopeRef)
      if (
        location.authority.state === 'unknown' ||
        (location.authority.state === 'bound' && !location.authority.isLocal)
      )
        return 'HRC authority unavailable or foreign'
      const runtimes = await input.hrcClient.listRuntimes({ scope: run.scopeRef, all: true })
      if (
        runtimes.some(
          (r) =>
            !deadRuntimes.has(r.status) &&
            (run.runtimeId !== undefined
              ? r.runtimeId === run.runtimeId
              : run.hostSessionId !== undefined
                ? r.hostSessionId === run.hostSessionId
                : true)
        )
      )
        return 'own HRC runtime is live'
      return undefined
    } catch {
      return 'HRC evidence unavailable'
    }
  }

  // This final corroboration is synchronous: no await between it and the ACP CAS.
  function localEvidenceProtects(run: StoredRun): boolean {
    const db = new Database(input.hrcDbPath, { readonly: true })
    try {
      const runtimes = db
        .prepare(`SELECT status FROM runtimes WHERE runtime_id = ?
        OR (? IS NULL AND host_session_id = ?)
        OR (? IS NULL AND ? IS NULL AND scope_ref = ? AND lane_ref = ?)`)
        .all(
          run.runtimeId ?? null,
          run.runtimeId ?? null,
          run.hostSessionId ?? null,
          run.runtimeId ?? null,
          run.hostSessionId ?? null,
          run.scopeRef,
          run.laneRef
        ) as { status: string }[]
      if (runtimes.some((runtime) => !deadRuntimes.has(runtime.status))) return true
      const evidence = db
        .prepare(`SELECT 1 FROM runs WHERE completed_at IS NULL
        AND status NOT IN ('completed','failed','cancelled','interrupted','rejected')
        AND (run_id = ? OR (runtime_id = ? AND ? IS NOT NULL)
          OR (? IS NULL AND host_session_id = ?)
          OR (? IS NULL AND ? IS NULL AND scope_ref = ? AND lane_ref = ?)) LIMIT 1`)
        .get(
          run.hrcRunId ?? null,
          run.runtimeId ?? null,
          run.runtimeId ?? null,
          run.runtimeId ?? null,
          run.hostSessionId ?? null,
          run.runtimeId ?? null,
          run.hostSessionId ?? null,
          run.scopeRef,
          run.laneRef
        )
      return evidence !== null
    } finally {
      db.close()
    }
  }

  async function reconcileApplications(
    apply: boolean,
    report: {
      actions: OrphanAction[]
      protected: { runId: string; reason: string }[]
    }
  ): Promise<void> {
    const store = input.inputApplicationStore
    if (store === undefined) return
    const ids = input.sqlite
      .prepare(`SELECT input_application_id FROM input_applications
      WHERE status IN ('pending','accepted') AND updated_at < ? ORDER BY input_application_id`)
      .all(new Date(now() - STALE_UNROUTABLE_MS).toISOString()) as {
      input_application_id: string
    }[]
    for (const { input_application_id: id } of ids) {
      const original = store.getById(id)
      const target =
        original?.targetRunId === undefined
          ? undefined
          : input.runStore.getRun(original.targetRunId)
      if (original === undefined) continue
      if (target === undefined) {
        report.protected.push({
          runId: original.targetRunId ?? '',
          reason: `${id}: no terminal target evidence`,
        })
        continue
      }
      if (!terminalRuns.has(target.status)) continue
      const identity: StoredRun = {
        ...target,
        runtimeId: original.runtimeId,
        hostSessionId: original.hostSessionId,
        hrcRunId: original.hrcRunId,
      }
      const protection = await proveDead(identity)
      if (protection !== undefined) {
        report.protected.push({ runId: target.runId, reason: `${id}: ${protection}` })
        continue
      }
      input.sqlite.transaction(() => {
        const current = store.getById(id)
        const currentTarget = input.runStore.getRun(target.runId)
        if (
          JSON.stringify(current) !== JSON.stringify(original) ||
          JSON.stringify(currentTarget) !== JSON.stringify(target)
        ) {
          report.protected.push({
            runId: target.runId,
            reason: `${id}: ACP state changed during proof`,
          })
          return
        }
        try {
          if (localEvidenceProtects(identity)) {
            report.protected.push({ runId: target.runId, reason: `${id}: own live HRC evidence` })
            return
          }
        } catch {
          report.protected.push({
            runId: target.runId,
            reason: `${id}: local HRC evidence unavailable`,
          })
          return
        }
        const cause = `terminal target ${target.status}; own HRC execution ended without proof of contribution application`
        if (apply)
          store.update(id, {
            status: 'ambiguous',
            lastErrorCode: 'stale_orphan',
            lastErrorMessage: cause,
          })
        report.actions.push({
          table: 'input_applications',
          id,
          runId: target.runId,
          from: original.status,
          to: 'ambiguous',
          reason: 'stale_orphan',
          cause,
        })
      })()
    }
  }

  async function reconcileJobs(apply: boolean, actions: OrphanAction[]): Promise<void> {
    const jobs = input.jobsStore
    if (jobs === undefined || input.verifyJobNode === undefined) return
    const candidates = () =>
      jobs.sqlite
        .prepare(`SELECT jr.*, j.job_id AS definition_id FROM job_runs jr
      LEFT JOIN jobs j ON j.job_id = jr.job_id
      WHERE jr.status IN ('pending','claimed','dispatched') AND jr.updated_at < ? ORDER BY jr.job_run_id`)
        .all(new Date(now() - STALE_UNROUTABLE_MS).toISOString()) as {
        job_run_id: string
        run_id: string | null
        input_attempt_id: string | null
        execution_node_id: string | null
        definition_id: string | null
        status: string
        updated_at: string
        lease_expires_at: string | null
        output_json: string | null
      }[]
    const original = candidates()
    if (original.length === 0) return
    let node: string | undefined
    try {
      node = await input.verifyJobNode()
    } catch {
      return
    }
    if (node === undefined) return
    // Re-read after asynchronous identity verification. Updates below are synchronous.
    for (const row of candidates()) {
      if (row.execution_node_id !== node) continue
      let to: JobRunStatus | undefined
      let reason: OrphanAction['reason'] = 'stale_orphan'
      let cause = 'deleted job definition; project terminal ACP run'
      if (row.status === 'dispatched' && row.definition_id === null && row.run_id !== null) {
        const run = input.runStore.getRun(row.run_id)
        const predicted = !apply
          ? actions.find((a) => a.table === 'runs' && a.id === row.run_id)?.to
          : undefined
        const status = predicted ?? run?.status
        if (status === 'completed') {
          // A deleted definition must not silently bypass undelivered output sinks.
          const output = row.output_json === null ? undefined : JSON.parse(row.output_json)
          if ((output?.sinks?.length ?? 0) > 0) continue
          to = 'succeeded'
        } else if (status === 'failed' || status === 'cancelled') to = 'failed'
      } else if (
        (row.status === 'claimed' || row.status === 'pending') &&
        row.run_id === null &&
        row.input_attempt_id === null &&
        aged(row.updated_at, STALE_NEVER_DISPATCHED_MS) &&
        (row.lease_expires_at === null || Date.parse(row.lease_expires_at) <= now())
      ) {
        to = 'failed'
        reason = 'stale_never_dispatched'
        cause = 'unlinked job claim exceeded seven-day retention without a live lease'
      }
      if (to === undefined) continue
      if (apply)
        jobs.updateJobRun(row.job_run_id, {
          status: to,
          errorCode: reason,
          errorMessage: cause,
          completedAt: new Date(now()).toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
      actions.push({
        table: 'job_runs',
        id: row.job_run_id,
        runId: row.run_id ?? '',
        from: row.status,
        to,
        reason,
        cause,
      })
    }
  }

  async function scan(apply: boolean) {
    const report: { actions: OrphanAction[]; protected: { runId: string; reason: string }[] } = {
      actions: [],
      protected: [],
    }
    const cutoff = new Date(now() - STALE_UNROUTABLE_MS).toISOString()
    const ids = input.sqlite
      .prepare(`SELECT run_id FROM runs WHERE status IN ('queued','running') AND updated_at < ?
      UNION SELECT run_id FROM input_queue WHERE status IN ('queued','leased','dispatching','running') AND updated_at < ?
      UNION SELECT run_id FROM input_admissions WHERE status IN ('queued','pending','accepted') AND updated_at < ? AND run_id IS NOT NULL
      ORDER BY run_id`)
      .all(cutoff, cutoff, cutoff) as { run_id: string }[]
    for (const { run_id: runId } of ids) {
      const original = snapshot(runId)
      if (original === undefined) continue
      const planned = classify(original)
      if (planned.length === 0) continue
      const started = planned.some((a) => a.reason === 'stale_unroutable')
      if (started) {
        const protection = await proveDead(original.run)
        if (protection !== undefined) {
          report.protected.push({ runId, reason: protection })
          continue
        }
      }
      input.sqlite.transaction(() => {
        const current = snapshot(runId)
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(original)) {
          report.protected.push({ runId, reason: 'ACP state changed during proof' })
          return
        }
        if (started) {
          try {
            if (localEvidenceProtects(current.run)) {
              report.protected.push({ runId, reason: 'own live HRC evidence' })
              return
            }
          } catch {
            report.protected.push({ runId, reason: 'local HRC evidence unavailable' })
            return
          }
        }
        const actions = classify(current)
        if (apply) {
          const runAction = actions.find((a) => a.table === 'runs')
          if (
            runAction !== undefined &&
            input.runStore.updateRunIfStatus(runId, current.run.status, {
              status: runAction.to as StoredRun['status'],
              errorCode: runAction.reason,
              errorMessage: runAction.cause,
            }) === undefined
          )
            return
          for (const action of actions) {
            if (action.table === 'input_queue')
              input.inputQueueStore.update(action.id, {
                status: action.to as Parameters<InputQueueStore['update']>[1]['status'],
                lastErrorCode: action.reason,
                lastErrorMessage: action.cause,
              })
            if (action.table === 'input_admissions') {
              const admission = input.inputAdmissionStore.getByInputAttemptId(action.id)
              input.inputAdmissionStore.update(action.id, {
                status: action.to,
                currentState: {
                  ...admission?.currentState,
                  runStatus: runAction?.to ?? current.run.status,
                  errorCode: action.reason,
                  reason: action.cause,
                },
              })
            }
          }
        }
        report.actions.push(...actions)
      })()
    }
    await reconcileApplications(apply, report)
    await reconcileJobs(apply, report.actions)
    if (apply && report.actions.length > 0)
      writeLogLine({
        level: 'info',
        component: 'stale-orphan-reaper',
        event: 'stale_orphan.reaped',
        data: { actions: report.actions },
      })
    return report
  }
  return { dryRun: () => scan(false), runOnce: () => scan(true) }
}
