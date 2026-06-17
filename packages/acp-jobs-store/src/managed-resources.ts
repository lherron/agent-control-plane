/**
 * Phase D STUB — managed-resource provenance for acp-jobs-store.
 *
 * This module is a MINIMAL THROWING STUB that exists solely to:
 *   1. Allow the Phase C RED tests to LOAD and RUN their test bodies.
 *   2. Freeze the Phase D API contract (types + exported symbol names).
 *
 * ALL runtime functions throw "not implemented". Phase D replaces these stubs
 * with real implementations that pass the RED tests in managed-resources-store.test.ts.
 *
 * DO NOT implement real logic here.
 */
import type { JobRecord, JobsStore } from './open-store.js'

// ---------------------------------------------------------------------------
// Types (API contract frozen by Phase C RED tests)
// ---------------------------------------------------------------------------

export type ResourceKindJob = 'scheduled-job' | 'event-hook'

export type ManagedJobProvenanceRecord = {
  provenanceId: string
  projectionId: string
  projectionPk: string
  jobId: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  resourceKind: ResourceKindJob
  managedBy: 'agent-directory'
  sourceVersion: number
  state: 'active' | 'disabled'
  appliedAt: string
  createdAt: string
  updatedAt: string
}

export type ApplyManagedJobInput = {
  projectionId: string
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  resourceKind: ResourceKindJob
  now: string
}

type CollisionError = {
  code: 'UNMANAGED_COLLISION' | 'FOREIGN_MANAGED_COLLISION'
  existingSlug?: string | undefined
  existingJobId?: string | undefined
}

type StaleAdoptionError = {
  code: 'STALE_ADOPTION'
  projectionId: string
  existingPk?: string | undefined
  incomingPk?: string | undefined
}

type ValidationError = {
  code: string
  message: string
}

export type ApplyManagedJobResult =
  | { outcome: 'created'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'updated'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'noop'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'collision'; error: CollisionError }
  | { outcome: 'stale_adoption_rejected'; error: StaleAdoptionError }
  | { outcome: 'validation_error'; error: ValidationError }

export type DriftReport = {
  hasDrift: boolean
  driftKind?: 'shape' | 'hash' | 'both' | undefined
  currentHash?: string | undefined
  desiredHash?: string | undefined
}

// ---------------------------------------------------------------------------
// Throwing stubs (Phase D replaces these)
// ---------------------------------------------------------------------------

export function applyManagedJob(
  _store: JobsStore,
  _input: ApplyManagedJobInput
): ApplyManagedJobResult {
  throw new Error('not implemented: applyManagedJob')
}

export function getManagedJobProvenance(
  _store: JobsStore,
  _projectionId: string
): ManagedJobProvenanceRecord | undefined {
  throw new Error('not implemented: getManagedJobProvenance')
}

export function listManagedJobProvenances(
  _store: JobsStore,
  _filter?: { ownerScopeRef?: string | undefined } | undefined
): ManagedJobProvenanceRecord[] {
  throw new Error('not implemented: listManagedJobProvenances')
}

export function detectJobDrift(_store: JobsStore, _projectionId: string): DriftReport {
  throw new Error('not implemented: detectJobDrift')
}

export function disableManagedJob(
  _store: JobsStore,
  _projectionId: string,
  _reason: 'source_missing'
): { job: JobRecord; provenance: ManagedJobProvenanceRecord } {
  throw new Error('not implemented: disableManagedJob')
}
