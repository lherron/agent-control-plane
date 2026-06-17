/**
 * Phase D STUB — managed-resource provenance for acp-interface-store.
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
import type { InterfaceBinding } from './types.js'
import type { InterfaceStore } from './open-store.js'

// ---------------------------------------------------------------------------
// Types (API contract frozen by Phase C RED tests)
// ---------------------------------------------------------------------------

export type ManagedBindingProvenanceRecord = {
  provenanceId: string
  projectionId: string
  projectionPk: string
  bindingId: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  resourceKind: 'interface-binding'
  managedBy: 'agent-directory'
  sourceVersion: number
  state: 'active' | 'disabled'
  appliedAt: string
  createdAt: string
  updatedAt: string
}

export type ApplyManagedBindingInput = {
  projectionId: string
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  resourceKind: 'interface-binding'
  now: string
}

type CollisionError = {
  code: 'UNMANAGED_COLLISION' | 'FOREIGN_MANAGED_COLLISION'
  existingBindingId?: string | undefined
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

export type ApplyManagedBindingResult =
  | { outcome: 'created'; binding: InterfaceBinding; provenance: ManagedBindingProvenanceRecord }
  | { outcome: 'updated'; binding: InterfaceBinding; provenance: ManagedBindingProvenanceRecord }
  | { outcome: 'noop'; binding: InterfaceBinding; provenance: ManagedBindingProvenanceRecord }
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

export function applyManagedBinding(
  _store: InterfaceStore,
  _input: ApplyManagedBindingInput
): ApplyManagedBindingResult {
  throw new Error('not implemented: applyManagedBinding')
}

export function getManagedBindingProvenance(
  _store: InterfaceStore,
  _projectionId: string
): ManagedBindingProvenanceRecord | undefined {
  throw new Error('not implemented: getManagedBindingProvenance')
}

export function detectBindingDrift(
  _store: InterfaceStore,
  _projectionId: string
): DriftReport {
  throw new Error('not implemented: detectBindingDrift')
}

export function disableManagedBinding(
  _store: InterfaceStore,
  _projectionId: string,
  _reason: 'source_missing'
): { binding: InterfaceBinding; provenance: ManagedBindingProvenanceRecord } {
  throw new Error('not implemented: disableManagedBinding')
}
