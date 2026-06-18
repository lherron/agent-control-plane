/**
 * Phase C RED tests — Phase D Store Layer: managed-resource provenance for jobs and event-hooks.
 *
 * STATUS: INTENTIONALLY FAILING — Phase D (managed-resources.ts) has not yet been implemented.
 * These tests will go GREEN when Phase D delivers:
 *   - managed_resource_provenance_jobs table in acp-jobs.db (same-transaction with jobs)
 *   - applyManagedJob / getManagedJobProvenance / listManagedJobProvenances /
 *     detectJobDrift / disableManagedJob exported from managed-resources.ts
 *
 * Wire input: canonical ASP plan fixture (agent-authored-runtime-resources.plan/v1).
 * These tests cover the STORE layer only; Phase E apply/status tests are in
 *   tests/conformance/managed-resources/apply-status.test.ts
 *
 * Invariants tested (from T-04868 / T-04883):
 *   - Same-transaction provenance (job row + provenance row atomic)
 *   - Provenance uniqueness constraints
 *   - Idempotent reapply (noop on re-apply, stable jobId)
 *   - Unmanaged collision fail-closed (UNMANAGED_COLLISION)
 *   - Differently-managed collision fail-closed (FOREIGN_MANAGED_COLLISION)
 *   - Stale adoption rejection (projectionId matches, projectionPk mismatches)
 *   - Drift detection (shape/hash comparison)
 *   - Disable-only deletion preserving event history
 *   - Event-hook cooldown validation (malformed, absent, untyped TOML object rejected)
 *   - Event-hook originPolicy.agent = allow rejected in v1
 *   - Reconcile must not mutate event_inbox / event_job_matches / job_runs
 */
import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'
// Phase D will create this module. Until then, this import fails at module resolution,
// making all tests in this file RED. When managed-resources.ts is created and exports
// these symbols, the tests will run and (when correctly implemented) go GREEN.
import {
  type ApplyManagedJobInput,
  type DriftReport,
  type ManagedJobProvenanceRecord,
  applyManagedJob,
  detectJobDrift,
  disableManagedJob,
  getManagedJobProvenance,
  listManagedJobProvenances,
} from '../managed-resources.js'

// ------------------------------------------------------------------
// Canonical wire inputs from the frozen ASP plan fixture v1
// ------------------------------------------------------------------

const NOW = '2026-06-17T22:00:00.000Z'
const OWNER_SCOPE = 'agent:smokey:project:agent-spaces'

/** Scheduled-job resource — matches expected-plan.json resource[0]. */
const SCHEDULED_JOB: ApplyManagedJobInput = {
  projectionId: 'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage',
  projectionPk: 'agent-smokey.daily-triage',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'daily-triage',
  sourcePath: 'agents/smokey/schedules/daily-triage.toml',
  sourceHash:
    'sha256-canonical-json/v1:4bc88e59a4360da45d0b98a6d33cc547548c44c8d33a852f3ff398a3e7994342',
  desiredProjectionHash:
    'sha256-canonical-json/v1:f144cdf218cafb31379bf256c86b0bfad0da28d2984b9ee0e12a700a327e9d7f',
  desiredJson: {
    kind: 'scheduled-job',
    slug: 'agent-smokey.daily-triage',
    projectId: 'agent-spaces',
    agentId: 'smokey',
    scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
    laneRef: 'main',
    title: 'Daily triage',
    disabled: false,
    trigger: { kind: 'schedule' },
    schedule: { cron: '0 8 * * 1-5', windowStart: '08:00', windowEnd: '18:00', windowMinutes: 30 },
    input: { content: 'Review new inbox tasks and summarize the highest-risk platform work.' },
  },
  resourceKind: 'scheduled-job',
  now: NOW,
}

/** Event-hook resource — matches expected-plan.json resource[2]. */
const EVENT_HOOK: ApplyManagedJobInput = {
  projectionId: 'agent-directory:agent:smokey:project:agent-spaces:event-hook:wrkq-needs-smoketest',
  projectionPk: 'agent-smokey.wrkq-needs-smoketest',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'wrkq-needs-smoketest',
  sourcePath: 'agents/smokey/event-hooks/wrkq-needs-smoketest.toml',
  sourceHash:
    'sha256-canonical-json/v1:9b3fc7d28216002bfa76d9706fdbbd93925b75134bfbeac6c67d8e76fcf59021',
  desiredProjectionHash:
    'sha256-canonical-json/v1:4a6069908b96fe71d414f02478a8bdb1cad0030e0167b748f7e38531b3f8a5b8',
  desiredJson: {
    kind: 'event-triggered-job',
    slug: 'agent-smokey.wrkq-needs-smoketest',
    projectId: 'agent-spaces',
    agentId: 'smokey',
    scopeRef: 'agent:smokey:project:agent-spaces:task:{{ticket_id}}',
    laneRef: 'main',
    title: 'Smokey handles wrkq needs_smoketest',
    disabled: false,
    trigger: {
      kind: 'event',
      source: 'wrkq',
      match: {
        event: ['updated', 'transitioned'],
        project_scope_id: 'agent-spaces',
        kind: 'task',
        transition: { to: 'in_progress' },
      },
      target: {
        project: '{{ project_scope_id }}',
        agent: 'smokey',
        lane: 'main',
        task: '{{ticket_id}}',
      },
      cooldown: 'PT300S',
      originPolicy: { agent: 'deny' },
    },
    input: { content: 'Run the smoke-test workflow for {{ticket_id}}.' },
  },
  resourceKind: 'event-hook',
  now: NOW,
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function freshStore() {
  return createInMemoryJobsStore()
}

// Helper to suppress unused-variable lint on type imports used only in assertions
function typeAssert<_T>(_v: _T): void {}
typeAssert<ManagedJobProvenanceRecord | undefined>(undefined)
typeAssert<DriftReport>({ hasDrift: false })

// ==================================================================
// Provenance table schema
// ==================================================================

describe('managed_resource_provenance_jobs schema (Phase D — store layer)', () => {
  test('managed_resource_provenance_jobs table exists after Phase D migration', () => {
    const store = freshStore()
    const tables = store.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
    expect(tables.map((r) => r.name)).toContain('managed_resource_provenance_jobs')
  })

  test('managed_resource_provenance_jobs has required columns', () => {
    const store = freshStore()
    const cols = store.sqlite
      .prepare("PRAGMA table_info('managed_resource_provenance_jobs')")
      .all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    for (const required of [
      'provenance_id',
      'projection_id',
      'projection_pk',
      'job_id',
      'source_owner_scope_ref',
      'source_hash',
      'desired_projection_hash',
      'resource_kind',
      'state',
      'applied_at',
      'created_at',
      'updated_at',
    ]) {
      expect(names).toContain(required)
    }
  })

  test('projection_id column has a UNIQUE constraint', () => {
    const store = freshStore()
    const indexes = store.sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='managed_resource_provenance_jobs'"
      )
      .all() as Array<{ name: string; sql: string }>
    const hasUnique = indexes.some(
      (i) =>
        i.sql?.toUpperCase().includes('UNIQUE') && i.sql?.toLowerCase().includes('projection_id')
    )
    expect(hasUnique).toBe(true)
  })
})

// ==================================================================
// Same-transaction provenance
// ==================================================================

describe('same-transaction provenance (Phase D invariant)', () => {
  test('applyManagedJob creates a job row and a provenance row atomically', () => {
    const store = freshStore()
    const result = applyManagedJob(store, SCHEDULED_JOB)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    // Job row must exist
    const { job } = store.getJob(result.job.jobId)
    expect(job).toBeDefined()
    expect(job?.slug).toBe('agent-smokey.daily-triage')
    expect(job?.disabled).toBe(false)

    // Provenance row must exist in the SAME store (written in the same SQLite transaction)
    const prov = getManagedJobProvenance(store, SCHEDULED_JOB.projectionId)
    expect(prov).toBeDefined()
    expect(prov?.jobId).toBe(result.job.jobId)
    expect(prov?.projectionId).toBe(SCHEDULED_JOB.projectionId)
    expect(prov?.projectionPk).toBe(SCHEDULED_JOB.projectionPk)
    expect(prov?.sourceHash).toBe(SCHEDULED_JOB.sourceHash)
    expect(prov?.desiredProjectionHash).toBe(SCHEDULED_JOB.desiredProjectionHash)
    expect(prov?.resourceKind).toBe('scheduled-job')
    expect(prov?.managedBy).toBe('agent-directory')
    expect(prov?.state).toBe('active')
  })

  test('applyManagedJob for event-hook projects to jobs table with trigger.kind = event', () => {
    const store = freshStore()
    const result = applyManagedJob(store, EVENT_HOOK)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    const { job } = store.getJob(result.job.jobId)
    expect(job?.trigger.kind).toBe('event')
    expect(job?.slug).toBe('agent-smokey.wrkq-needs-smoketest')

    const prov = getManagedJobProvenance(store, EVENT_HOOK.projectionId)
    expect(prov).toBeDefined()
    expect(prov?.resourceKind).toBe('event-hook')
    expect(prov?.jobId).toBe(result.job.jobId)
  })

  test('failed apply due to collision does not leave an orphaned provenance row', () => {
    const store = freshStore()
    // Pre-seed an unmanaged job at the same slug
    store.createJob({
      slug: 'agent-smokey.daily-triage',
      projectId: 'agent-spaces',
      agentId: 'smokey',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      schedule: { cron: '0 8 * * *' },
      input: { content: 'unmanaged pre-existing job' },
    })

    const result = applyManagedJob(store, SCHEDULED_JOB)
    expect(result.outcome).toBe('collision')

    // Transaction was rolled back — no orphaned provenance
    const prov = getManagedJobProvenance(store, SCHEDULED_JOB.projectionId)
    expect(prov).toBeUndefined()
  })
})

// ==================================================================
// Provenance uniqueness constraints
// ==================================================================

describe('provenance uniqueness constraints (Phase D invariant)', () => {
  test('two resources with the same projectionId but different projectionPk → stale_adoption_rejected', () => {
    const store = freshStore()
    const first = applyManagedJob(store, SCHEDULED_JOB)
    expect(first.outcome).toBe('created')

    // Attempt to apply a resource with the same projectionId but a different slug
    const impostor: ApplyManagedJobInput = {
      ...SCHEDULED_JOB,
      projectionPk: 'agent-smokey.daily-triage-v2',
      desiredJson: { ...SCHEDULED_JOB.desiredJson, slug: 'agent-smokey.daily-triage-v2' },
    }
    const second = applyManagedJob(store, impostor)
    expect(second.outcome).toBe('stale_adoption_rejected')
  })

  test('two distinct projectionIds with distinct projectionPks are both accepted', () => {
    const store = freshStore()
    expect(applyManagedJob(store, SCHEDULED_JOB).outcome).toBe('created')
    expect(applyManagedJob(store, EVENT_HOOK).outcome).toBe('created')
    expect(listManagedJobProvenances(store, { ownerScopeRef: OWNER_SCOPE })).toHaveLength(2)
  })
})

// ==================================================================
// Idempotent reapply
// ==================================================================

describe('idempotent reapply (Phase D invariant)', () => {
  test('applying the same resource twice produces noop on the second call', () => {
    const store = freshStore()
    expect(applyManagedJob(store, SCHEDULED_JOB).outcome).toBe('created')
    expect(applyManagedJob(store, SCHEDULED_JOB).outcome).toBe('noop')

    // Exactly one job row and one provenance row
    expect(
      store.listJobs().jobs.filter((j) => j.slug === 'agent-smokey.daily-triage')
    ).toHaveLength(1)
    expect(getManagedJobProvenance(store, SCHEDULED_JOB.projectionId)).toBeDefined()
  })

  test('event-hook with source-only trigger.target produces noop on reapply', () => {
    const store = freshStore()
    expect(applyManagedJob(store, EVENT_HOOK).outcome).toBe('created')
    expect(applyManagedJob(store, EVENT_HOOK).outcome).toBe('noop')
  })

  test('reapply preserves the original jobId (stable projection identity)', () => {
    const store = freshStore()
    const first = applyManagedJob(store, SCHEDULED_JOB)
    if (first.outcome !== 'created') throw new Error(`expected created, got ${first.outcome}`)

    const second = applyManagedJob(store, SCHEDULED_JOB)
    expect(['noop', 'updated']).toContain(second.outcome)
    expect(second.job.jobId).toBe(first.job.jobId)
  })

  test('reapply with changed desiredJson produces "updated" outcome and updates provenance hash', () => {
    const store = freshStore()
    applyManagedJob(store, SCHEDULED_JOB)

    const changed: ApplyManagedJobInput = {
      ...SCHEDULED_JOB,
      sourceHash: `sha256-canonical-json/v1:${'a'.repeat(64)}`,
      desiredProjectionHash: `sha256-canonical-json/v1:${'b'.repeat(64)}`,
      desiredJson: { ...SCHEDULED_JOB.desiredJson, title: 'Daily triage (revised)' },
    }
    const result = applyManagedJob(store, changed)
    expect(result.outcome).toBe('updated')

    const prov = getManagedJobProvenance(store, SCHEDULED_JOB.projectionId)
    expect(prov?.desiredProjectionHash).toBe(changed.desiredProjectionHash)
    expect(prov?.sourceHash).toBe(changed.sourceHash)
  })
})

// ==================================================================
// Collision: unmanaged / differently-managed
// ==================================================================

describe('collision fail-closed behavior (Phase D invariant)', () => {
  test('slug exists with no provenance → UNMANAGED_COLLISION', () => {
    const store = freshStore()
    store.createJob({
      slug: 'agent-smokey.daily-triage',
      projectId: 'agent-spaces',
      agentId: 'smokey',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      schedule: { cron: '0 8 * * *' },
      input: { content: 'pre-existing unmanaged job' },
    })

    const result = applyManagedJob(store, SCHEDULED_JOB)
    expect(result.outcome).toBe('collision')
    if (result.outcome !== 'collision') return
    expect(result.error.code).toBe('UNMANAGED_COLLISION')
  })

  test('slug owned by a different projectionId → FOREIGN_MANAGED_COLLISION', () => {
    const store = freshStore()
    const foreign: ApplyManagedJobInput = {
      ...SCHEDULED_JOB,
      projectionId: 'agent-directory:agent:foreign:project:other:scheduled-job:daily-triage',
      sourceOwnerScopeRef: 'agent:foreign:project:other',
    }
    expect(applyManagedJob(store, foreign).outcome).toBe('created')

    const result = applyManagedJob(store, SCHEDULED_JOB)
    expect(result.outcome).toBe('collision')
    if (result.outcome !== 'collision') return
    expect(result.error.code).toBe('FOREIGN_MANAGED_COLLISION')
  })

  test('collision does not mutate the pre-existing job row', () => {
    const store = freshStore()
    store.createJob({
      slug: 'agent-smokey.daily-triage',
      projectId: 'agent-spaces',
      agentId: 'smokey',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      schedule: { cron: '0 8 * * *' },
      input: { content: 'guarded pre-existing content' },
    })
    applyManagedJob(store, SCHEDULED_JOB)

    const { jobs } = store.listJobs()
    const job = jobs.find((j) => j.slug === 'agent-smokey.daily-triage')
    expect(job?.input.content).toBe('guarded pre-existing content')
  })
})

// ==================================================================
// Stale adoption failure
// ==================================================================

describe('stale adoption failure (Phase D invariant)', () => {
  test('projectionId matches existing provenance but projectionPk mismatches → stale_adoption_rejected', () => {
    const store = freshStore()
    applyManagedJob(store, SCHEDULED_JOB)

    const staleAttempt: ApplyManagedJobInput = {
      ...SCHEDULED_JOB,
      projectionPk: 'agent-smokey.daily-triage-renamed',
      desiredJson: { ...SCHEDULED_JOB.desiredJson, slug: 'agent-smokey.daily-triage-renamed' },
    }
    const result = applyManagedJob(store, staleAttempt)
    expect(result.outcome).toBe('stale_adoption_rejected')
    if (result.outcome !== 'stale_adoption_rejected') return
    expect(result.error.code).toBe('STALE_ADOPTION')
  })
})

// ==================================================================
// Drift detection
// ==================================================================

describe('drift detection (Phase D invariant)', () => {
  test('detectJobDrift returns no drift for a freshly applied resource', () => {
    const store = freshStore()
    applyManagedJob(store, SCHEDULED_JOB)
    const drift = detectJobDrift(store, SCHEDULED_JOB.projectionId)
    expect(drift.hasDrift).toBe(false)
  })

  test('detectJobDrift returns no drift for a fresh event-hook with trigger.target', () => {
    const store = freshStore()
    applyManagedJob(store, EVENT_HOOK)
    const drift = detectJobDrift(store, EVENT_HOOK.projectionId)
    expect(drift.hasDrift).toBe(false)
  })

  test('detectJobDrift reports drift after out-of-band mutation', () => {
    const store = freshStore()
    const created = applyManagedJob(store, SCHEDULED_JOB)
    if (created.outcome !== 'created') throw new Error('expected created')

    // Operator disables the job directly (outside managed-resources)
    store.updateJob(created.job.jobId, { disabled: true })

    const drift = detectJobDrift(store, SCHEDULED_JOB.projectionId)
    expect(drift.hasDrift).toBe(true)
    expect(drift.driftKind).toBeDefined()
  })

  test('detectJobDrift for unknown projectionId returns hasDrift=false (resource absent)', () => {
    const store = freshStore()
    const drift = detectJobDrift(store, 'agent-directory:nonexistent:resource')
    expect(drift.hasDrift).toBe(false)
  })
})

// ==================================================================
// Disable-only: missing source preserves history
// ==================================================================

describe('disable-only missing-source behavior (Phase D invariant)', () => {
  test('disableManagedJob sets disabled=true but does NOT archive the job', () => {
    const store = freshStore()
    const created = applyManagedJob(store, SCHEDULED_JOB)
    if (created.outcome !== 'created') throw new Error('expected created')

    const { job: disabled } = disableManagedJob(store, SCHEDULED_JOB.projectionId, 'source_missing')
    expect(disabled.disabled).toBe(true)

    // Job still exists — not archived — history preserved
    const { job: fetched } = store.getJob(disabled.jobId)
    expect(fetched).toBeDefined()
    expect(fetched?.disabled).toBe(true)
  })

  test('disableManagedJob marks provenance.state = disabled', () => {
    const store = freshStore()
    applyManagedJob(store, SCHEDULED_JOB)
    disableManagedJob(store, SCHEDULED_JOB.projectionId, 'source_missing')

    const prov = getManagedJobProvenance(store, SCHEDULED_JOB.projectionId)
    expect(prov?.state).toBe('disabled')
  })

  test('disabling an event-hook does NOT purge event_inbox rows (history preserved)', () => {
    const store = freshStore()
    const created = applyManagedJob(store, EVENT_HOOK)
    if (created.outcome !== 'created') throw new Error('expected created')

    // Seed a historical inbox event
    store.eventInbox.insert({
      source: 'wrkq',
      eventId: 'evt_pre_disable',
      eventSeq: 1,
      event: 'transitioned',
      payload: { ticket_id: 'T-99999', project_scope_id: 'agent-spaces' },
    })

    disableManagedJob(store, EVENT_HOOK.projectionId, 'source_missing')

    const rows = store.sqlite
      .prepare("SELECT event_id FROM event_inbox WHERE event_id = 'wrkq:evt_pre_disable'")
      .all() as Array<{ event_id: string }>
    expect(rows).toHaveLength(1)
  })
})

// ==================================================================
// Event-hook: cooldown and originPolicy invariants
// ==================================================================

describe('event-hook cooldown validation (Phase D invariant)', () => {
  test('event-hook stores the canonical PT300S cooldown on the trigger', () => {
    const store = freshStore()
    const result = applyManagedJob(store, EVENT_HOOK)
    if (result.outcome !== 'created') throw new Error('expected created')

    const { job } = store.getJob(result.job.jobId)
    const trigger = job?.trigger
    if (trigger?.kind !== 'event') throw new Error('expected event trigger')
    // PT300S must parse to 300 seconds; validateJobTrigger accepts it as canonical
    expect(trigger.cooldown).toBe('PT300S')
  })

  test('event-hook stores originPolicy.agent = deny on the trigger', () => {
    const store = freshStore()
    const result = applyManagedJob(store, EVENT_HOOK)
    if (result.outcome !== 'created') throw new Error('expected created')

    const { job } = store.getJob(result.job.jobId)
    const trigger = job?.trigger
    if (trigger?.kind !== 'event') throw new Error('expected event trigger')
    expect(trigger.originPolicy?.agent).toBe('deny')
  })

  test('event-hook with untyped TOML object cooldown is rejected before apply', () => {
    const store = freshStore()
    const malformed: ApplyManagedJobInput = {
      ...EVENT_HOOK,
      desiredJson: {
        ...EVENT_HOOK.desiredJson,
        trigger: {
          ...(EVENT_HOOK.desiredJson['trigger'] as Record<string, unknown>),
          cooldown: { minutes: 5 }, // object — NOT a duration string
        },
      },
    }
    const result = applyManagedJob(store, malformed)
    expect(result.outcome).toBe('validation_error')
    if (result.outcome !== 'validation_error') return
    expect(result.error.code).toMatch(/MALFORMED_COOLDOWN|INVALID_COOLDOWN/)
  })

  test('event-hook with absent cooldown is rejected before apply', () => {
    const store = freshStore()
    const noCooldown: ApplyManagedJobInput = {
      ...EVENT_HOOK,
      desiredJson: {
        ...EVENT_HOOK.desiredJson,
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: {
            event: ['updated', 'transitioned'],
            project_scope_id: 'agent-spaces',
            kind: 'task',
            transition: { to: 'in_progress' },
          },
          target: {
            project: '{{ project_scope_id }}',
            agent: 'smokey',
            lane: 'main',
            task: '{{ticket_id}}',
          },
          // cooldown intentionally absent — should be rejected
          originPolicy: { agent: 'deny' },
        },
      },
    }
    const result = applyManagedJob(store, noCooldown)
    expect(result.outcome).toBe('validation_error')
    if (result.outcome !== 'validation_error') return
    expect(result.error.code).toMatch(/ABSENT_COOLDOWN|MISSING_COOLDOWN/)
  })

  test('event-hook with originPolicy.agent = allow is rejected in v1', () => {
    const store = freshStore()
    const allowOrigin: ApplyManagedJobInput = {
      ...EVENT_HOOK,
      desiredJson: {
        ...EVENT_HOOK.desiredJson,
        trigger: {
          ...(EVENT_HOOK.desiredJson['trigger'] as Record<string, unknown>),
          originPolicy: { agent: 'allow' }, // allow is not permitted in v1
        },
      },
    }
    const result = applyManagedJob(store, allowOrigin)
    expect(result.outcome).toBe('validation_error')
    if (result.outcome !== 'validation_error') return
    expect(result.error.code).toMatch(/ORIGIN_ALLOW_REJECTED|INVALID_ORIGIN_POLICY/)
  })
})

// ==================================================================
// Reconcile must NOT mutate event runtime facts
// ==================================================================

describe('reconcile must not mutate event runtime facts (Phase D invariant)', () => {
  test('applying a managed event-hook does not mutate pre-existing event_inbox rows', () => {
    const store = freshStore()

    // Seed inbox event BEFORE apply
    store.eventInbox.insert({
      source: 'wrkq',
      eventId: 'evt_pre_apply',
      eventSeq: 1,
      event: 'transitioned',
      payload: { ticket_id: 'T-00001', project_scope_id: 'agent-spaces' },
    })

    applyManagedJob(store, EVENT_HOOK)

    const rows = store.sqlite
      .prepare("SELECT event_id, status FROM event_inbox WHERE event_id = 'wrkq:evt_pre_apply'")
      .all() as Array<{ event_id: string; status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
  })

  test('updating a managed event-hook via reapply does not mutate event_job_matches', () => {
    const store = freshStore()
    applyManagedJob(store, EVENT_HOOK)

    // Locate the created job
    const hookJob = store
      .listJobs()
      .jobs.find((j) => j.slug === 'agent-smokey.wrkq-needs-smoketest')
    if (!hookJob) throw new Error('event-hook job not found')

    // Seed a historical match outcome (simulates a prior event processing cycle)
    store.mintEventJobRun({
      sourceEventId: 'wrkq:evt_historical',
      eventSeq: 1,
      jobId: hookJob.jobId,
      resolvedScopeRef: 'agent:smokey:project:agent-spaces:task:T-00001',
      resolvedLaneRef: 'main',
      resolvedInput: { content: 'Run the smoke-test workflow for T-00001.' },
      source: { kind: 'webhook', source: 'wrkq', eventId: 'wrkq:evt_historical', eventSeq: 1 },
      targetTaskId: 'T-00001',
    })

    const beforeMatches = store.listEventJobMatches({
      sourceEventId: 'wrkq:evt_historical',
    }).matches

    // Reapply with an updated title (simulates a plan change)
    const updated: ApplyManagedJobInput = {
      ...EVENT_HOOK,
      sourceHash: `sha256-canonical-json/v1:${'c'.repeat(64)}`,
      desiredProjectionHash: `sha256-canonical-json/v1:${'d'.repeat(64)}`,
      desiredJson: {
        ...EVENT_HOOK.desiredJson,
        title: 'Smokey handles wrkq needs_smoketest (updated)',
      },
    }
    applyManagedJob(store, updated)

    const afterMatches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_historical' }).matches
    expect(afterMatches).toHaveLength(beforeMatches.length)
    expect(afterMatches[0]?.jobRunId).toBe(beforeMatches[0]?.jobRunId)
  })

  test('disabling a managed event-hook does not mutate job_runs for the job', () => {
    const store = freshStore()
    applyManagedJob(store, EVENT_HOOK)

    const hookJob = store
      .listJobs()
      .jobs.find((j) => j.slug === 'agent-smokey.wrkq-needs-smoketest')
    if (!hookJob) throw new Error('event-hook job not found')

    // Seed a historical job run
    store.mintEventJobRun({
      sourceEventId: 'wrkq:evt_run_history',
      eventSeq: 1,
      jobId: hookJob.jobId,
      resolvedScopeRef: 'agent:smokey:project:agent-spaces:task:T-00002',
      resolvedLaneRef: 'main',
      resolvedInput: { content: 'Run the smoke-test workflow for T-00002.' },
      source: { kind: 'webhook' },
      targetTaskId: 'T-00002',
    })

    const runsBefore = store.listJobRuns(hookJob.jobId).jobRuns

    disableManagedJob(store, EVENT_HOOK.projectionId, 'source_missing')

    const runsAfter = store.listJobRuns(hookJob.jobId).jobRuns
    // Job runs must be preserved — disable must NOT purge run history
    expect(runsAfter).toHaveLength(runsBefore.length)
    expect(runsAfter[0]?.jobRunId).toBe(runsBefore[0]?.jobRunId)
  })
})
