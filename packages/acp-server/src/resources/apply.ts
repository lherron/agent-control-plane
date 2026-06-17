/**
 * Phase E STUB — apply/status orchestrator for managed runtime resources.
 *
 * This module is a MINIMAL THROWING STUB that exists solely to:
 *   1. Allow the Phase C RED tests to LOAD and RUN their test bodies.
 *   2. Freeze the Phase E API contract (types + exported symbol names).
 *
 * ALL runtime functions throw "not implemented". Phase E replaces these stubs
 * with real implementations that pass the RED tests in
 * tests/conformance/managed-resources/apply-status.test.ts.
 *
 * Phase E MUST call Phase D store APIs only — no direct SQLite writes.
 *
 * DO NOT implement real logic here.
 */

// ---------------------------------------------------------------------------
// Types (API contract frozen by Phase C RED tests)
// ---------------------------------------------------------------------------

export type ManagedResourceProjection = {
  projectionId: string
  resourceKind: 'scheduled-job' | 'event-hook' | 'interface-binding'
  projectionTable: 'jobs' | 'interface_bindings'
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  sourceVersion: 1
  managedBy: 'agent-directory'
  origin: 'created'
  lastReconciledAt: 'pending-apply'
  createdAt: 'pending-apply'
  updatedAt: 'pending-apply'
}

export type ManagedResourcesPlan = {
  schema: 'agent-authored-runtime-resources.plan/v1'
  sourceOwnerScopeRef: string
  managedBy: 'agent-directory'
  compiler: { name: 'spaces-config/resources'; version: 1 }
  resources: ManagedResourceProjection[]
}

export type ResourceOutcome = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  outcome:
    | 'created'
    | 'updated'
    | 'noop'
    | 'collision'
    | 'stale_adoption_rejected'
    | 'validation_error'
    | 'failed'
  error?: { code: string; message: string } | undefined
}

export type ApplyManagedResourcesResult = {
  outcomes: ResourceOutcome[]
  stats: { created: number; updated: number; noop: number; failed: number }
}

export type ApplyManagedResourcesPlanInput = {
  plan: ManagedResourcesPlan
  jobsDbPath: string
  interfaceDbPath: string
  now: string
}

export type PlanValidationResult =
  | { valid: true }
  | { valid: false; errors: Array<{ field: string; message: string }> }

export type ManagedResourceStatusEntry = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  state: 'active' | 'disabled'
  hasDrift: boolean
  driftKind?: string | undefined
}

export type GetManagedResourcesStatusInput = {
  ownerScopeRef: string
  jobsDbPath: string
  interfaceDbPath: string
}

export type GetManagedResourcesStatusResult = {
  resources: ManagedResourceStatusEntry[]
}

// ---------------------------------------------------------------------------
// Throwing stubs (Phase E replaces these)
// ---------------------------------------------------------------------------

export function validateManagedResourcesPlan(
  _rawPlan: unknown
): PlanValidationResult {
  throw new Error('not implemented: validateManagedResourcesPlan')
}

export async function applyManagedResourcesPlan(
  _input: ApplyManagedResourcesPlanInput
): Promise<ApplyManagedResourcesResult> {
  throw new Error('not implemented: applyManagedResourcesPlan')
}

export async function getManagedResourcesStatus(
  _input: GetManagedResourcesStatusInput
): Promise<GetManagedResourcesStatusResult> {
  throw new Error('not implemented: getManagedResourcesStatus')
}
