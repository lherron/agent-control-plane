import { createHash, randomUUID } from 'node:crypto'

import type { InterfaceStore } from './open-store.js'
import type { InterfaceBinding } from './types.js'

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

type ProvenanceInterfaceRow = {
  provenance_id: string
  projection_id: string
  projection_pk: string
  binding_id: string
  source_owner_scope_ref: string
  resource_name: string
  source_path: string
  source_hash: string
  desired_projection_hash: string
  desired_projection_json: string
  resource_kind: 'interface-binding'
  managed_by: 'agent-directory'
  source_version: number
  state: 'active' | 'disabled'
  applied_at: string
  created_at: string
  updated_at: string
}

function newProvenanceId(): string {
  return `mbind_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  if (!isRecord(value)) {
    return JSON.stringify(value)
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function internalHash(value: unknown): string {
  return `sha256-internal/v1:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function rowToProvenance(row: ProvenanceInterfaceRow): ManagedBindingProvenanceRecord {
  return {
    provenanceId: row.provenance_id,
    projectionId: row.projection_id,
    projectionPk: row.projection_pk,
    bindingId: row.binding_id,
    sourceOwnerScopeRef: row.source_owner_scope_ref,
    resourceName: row.resource_name,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    desiredProjectionHash: row.desired_projection_hash,
    resourceKind: row.resource_kind,
    managedBy: row.managed_by,
    sourceVersion: row.source_version,
    state: row.state,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getProvenanceRow(
  store: InterfaceStore,
  projectionId: string
): ProvenanceInterfaceRow | undefined {
  return store.sqlite
    .prepare('SELECT * FROM managed_resource_provenance_interface WHERE projection_id = ?')
    .get(projectionId) as ProvenanceInterfaceRow | undefined
}

function getProvenanceByBindingId(
  store: InterfaceStore,
  bindingId: string
): ProvenanceInterfaceRow | undefined {
  return store.sqlite
    .prepare('SELECT * FROM managed_resource_provenance_interface WHERE binding_id = ?')
    .get(bindingId) as ProvenanceInterfaceRow | undefined
}

function getString(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key]
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new Error(`desiredJson.${key} must be a non-empty string`)
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) {
    throw new Error(`desiredJson.${key} must be an object`)
  }
  return value
}

function bindingFromDesired(input: ApplyManagedBindingInput): InterfaceBinding | ValidationError {
  const desired = input.desiredJson
  const routing = getRecord(desired, 'routing')
  const bindingId = getString(desired, 'bindingId', input.projectionPk)
  const scopeRef = getString(routing, 'scopeRef')
  const laneRef = getString(routing, 'laneRef')
  const projectId = getString(routing, 'projectId')
  const agentId = getString(routing, 'agentId')
  const status = getString(desired, 'status', 'active')
  if (status !== 'active' && status !== 'disabled') {
    return {
      code: 'INVALID_STATUS',
      message: "interface binding status must be 'active' or 'disabled'",
    }
  }

  return {
    bindingId,
    gatewayId: getString(desired, 'gatewayId'),
    gatewayType: getString(desired, 'gatewayType', 'unknown'),
    conversationRef: getString(desired, 'conversationRef'),
    threadRef: getOptionalString(desired, 'threadRef'),
    scopeRef,
    laneRef,
    projectId,
    agentId,
    taskId: getOptionalString(routing, 'taskId'),
    roleName: getOptionalString(routing, 'roleName'),
    status,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function updateBinding(store: InterfaceStore, binding: InterfaceBinding): InterfaceBinding {
  store.sqlite
    .prepare(
      `UPDATE interface_bindings
          SET gateway_id = ?,
              gateway_type = ?,
              conversation_ref = ?,
              thread_ref = ?,
              lane_ref = ?,
              project_id = ?,
              agent_id = ?,
              task_id = ?,
              role_name = ?,
              status = ?,
              updated_at = ?
        WHERE binding_id = ?`
    )
    .run(
      binding.gatewayId,
      binding.gatewayType,
      binding.conversationRef,
      binding.threadRef ?? null,
      binding.laneRef,
      binding.projectId ?? null,
      binding.agentId ?? null,
      binding.taskId ?? null,
      binding.roleName ?? null,
      binding.status,
      binding.updatedAt,
      binding.bindingId
    )
  const updated = store.bindings.getById(binding.bindingId)
  if (updated === undefined) {
    throw new Error(`interface binding not found after update: ${binding.bindingId}`)
  }
  return updated
}

function liveProjectionFromBinding(
  binding: InterfaceBinding,
  desiredJson: Record<string, unknown>
): Record<string, unknown> {
  const live: Record<string, unknown> = { ...desiredJson }
  const desiredRouting = isRecord(desiredJson['routing']) ? desiredJson['routing'] : {}
  live['bindingId'] = binding.bindingId
  live['gatewayId'] = binding.gatewayId
  live['gatewayType'] = binding.gatewayType
  live['conversationRef'] = binding.conversationRef
  live['threadRef'] = binding.threadRef
  live['status'] = binding.status
  live['routing'] = {
    ...desiredRouting,
    projectId: binding.projectId,
    agentId: binding.agentId,
    taskId: binding.taskId,
    laneRef: binding.laneRef,
  }
  return live
}

function insertProvenance(
  store: InterfaceStore,
  input: ApplyManagedBindingInput,
  binding: InterfaceBinding
): ManagedBindingProvenanceRecord {
  const rowFingerprint = internalHash(liveProjectionFromBinding(binding, input.desiredJson))
  const provenanceId = newProvenanceId()
  store.sqlite
    .prepare(
      `INSERT INTO managed_resource_provenance_interface (
         provenance_id,
         projection_id,
         projection_pk,
         projection_row_fingerprint,
         projection_row_updated_at,
         binding_id,
         source_owner_scope_ref,
         resource_name,
         source_path,
         source_hash,
         desired_projection_hash,
         desired_projection_json,
         resource_kind,
         managed_by,
         source_version,
         state,
         applied_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'interface-binding', 'agent-directory', 1, 'active', ?, ?, ?)`
    )
    .run(
      provenanceId,
      input.projectionId,
      input.projectionPk,
      rowFingerprint,
      binding.updatedAt,
      binding.bindingId,
      input.sourceOwnerScopeRef,
      input.resourceName,
      input.sourcePath,
      input.sourceHash,
      input.desiredProjectionHash,
      stableJson(input.desiredJson),
      input.now,
      input.now,
      input.now
    )

  return rowToProvenance(getProvenanceRow(store, input.projectionId) as ProvenanceInterfaceRow)
}

function updateProvenance(
  store: InterfaceStore,
  input: ApplyManagedBindingInput,
  existing: ManagedBindingProvenanceRecord,
  binding: InterfaceBinding
): ManagedBindingProvenanceRecord {
  const rowFingerprint = internalHash(liveProjectionFromBinding(binding, input.desiredJson))
  store.sqlite
    .prepare(
      `UPDATE managed_resource_provenance_interface
          SET projection_row_fingerprint = ?,
              projection_row_updated_at = ?,
              source_hash = ?,
              desired_projection_hash = ?,
              desired_projection_json = ?,
              state = 'active',
              source_version = ?,
              applied_at = ?,
              updated_at = ?
        WHERE projection_id = ?`
    )
    .run(
      rowFingerprint,
      binding.updatedAt,
      input.sourceHash,
      input.desiredProjectionHash,
      stableJson(input.desiredJson),
      existing.sourceVersion + 1,
      input.now,
      input.now,
      input.projectionId
    )

  return rowToProvenance(getProvenanceRow(store, input.projectionId) as ProvenanceInterfaceRow)
}

function collisionForBinding(
  store: InterfaceStore,
  projectionId: string,
  binding: InterfaceBinding
): ApplyManagedBindingResult | undefined {
  const owner = getProvenanceByBindingId(store, binding.bindingId)
  if (owner === undefined) {
    return {
      outcome: 'collision',
      error: { code: 'UNMANAGED_COLLISION', existingBindingId: binding.bindingId },
    }
  }
  if (owner.projection_id !== projectionId) {
    return {
      outcome: 'collision',
      error: { code: 'FOREIGN_MANAGED_COLLISION', existingBindingId: binding.bindingId },
    }
  }
  return undefined
}

export function applyManagedBinding(
  store: InterfaceStore,
  input: ApplyManagedBindingInput
): ApplyManagedBindingResult {
  let bindingInput: InterfaceBinding
  try {
    const converted = bindingFromDesired(input)
    if ('code' in converted) {
      return { outcome: 'validation_error', error: converted }
    }
    bindingInput = converted
  } catch (error) {
    return {
      outcome: 'validation_error',
      error: {
        code: 'INVALID_PROJECTION',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  return store.runInTransaction(() => {
    const existingRow = getProvenanceRow(store, input.projectionId)
    const existing = existingRow === undefined ? undefined : rowToProvenance(existingRow)
    if (existing !== undefined && existing.projectionPk !== input.projectionPk) {
      return {
        outcome: 'stale_adoption_rejected',
        error: {
          code: 'STALE_ADOPTION',
          projectionId: input.projectionId,
          existingPk: existing.projectionPk,
          incomingPk: input.projectionPk,
        },
      } satisfies ApplyManagedBindingResult
    }

    const bindingAtId = store.bindings.getById(bindingInput.bindingId)
    if (existing === undefined && bindingAtId !== undefined) {
      const collision = collisionForBinding(store, input.projectionId, bindingAtId)
      if (collision !== undefined) {
        return collision
      }
    }

    if (existing !== undefined) {
      const existingBinding = store.bindings.getById(existing.bindingId)
      if (existingBinding === undefined) {
        return {
          outcome: 'collision',
          error: { code: 'UNMANAGED_COLLISION', existingBindingId: existing.bindingId },
        } satisfies ApplyManagedBindingResult
      }
      if (bindingAtId !== undefined && bindingAtId.bindingId !== existing.bindingId) {
        const collision = collisionForBinding(store, input.projectionId, bindingAtId)
        if (collision !== undefined) {
          return collision
        }
      }

      const liveProjection = liveProjectionFromBinding(existingBinding, input.desiredJson)
      if (
        existing.sourceHash === input.sourceHash &&
        existing.desiredProjectionHash === input.desiredProjectionHash &&
        existing.state === 'active' &&
        stableJson(liveProjection) === stableJson(input.desiredJson)
      ) {
        return { outcome: 'noop', binding: existingBinding, provenance: existing }
      }

      const binding = updateBinding(store, { ...bindingInput, bindingId: existing.bindingId })
      const provenance = updateProvenance(store, input, existing, binding)
      return { outcome: 'updated', binding, provenance }
    }

    const binding = store.bindings.create(bindingInput)
    const provenance = insertProvenance(store, input, binding)
    return { outcome: 'created', binding, provenance }
  })
}

export function getManagedBindingProvenance(
  store: InterfaceStore,
  projectionId: string
): ManagedBindingProvenanceRecord | undefined {
  const row = getProvenanceRow(store, projectionId)
  return row === undefined ? undefined : rowToProvenance(row)
}

export function listManagedBindingProvenances(
  store: InterfaceStore,
  filter?: { ownerScopeRef?: string | undefined } | undefined
): ManagedBindingProvenanceRecord[] {
  const rows =
    filter?.ownerScopeRef === undefined
      ? (store.sqlite
          .prepare('SELECT * FROM managed_resource_provenance_interface ORDER BY created_at ASC')
          .all() as ProvenanceInterfaceRow[])
      : (store.sqlite
          .prepare(
            `SELECT *
               FROM managed_resource_provenance_interface
              WHERE source_owner_scope_ref = ?
              ORDER BY created_at ASC`
          )
          .all(filter.ownerScopeRef) as ProvenanceInterfaceRow[])
  return rows.map(rowToProvenance)
}

export function detectBindingDrift(store: InterfaceStore, projectionId: string): DriftReport {
  const row = getProvenanceRow(store, projectionId)
  if (row === undefined) {
    return { hasDrift: false }
  }

  const binding = store.bindings.getById(row.binding_id)
  if (binding === undefined) {
    return {
      hasDrift: true,
      driftKind: 'both',
      desiredHash: row.desired_projection_hash,
    }
  }

  const desiredJson = JSON.parse(row.desired_projection_json) as Record<string, unknown>
  const currentProjection = liveProjectionFromBinding(binding, desiredJson)
  if (stableJson(currentProjection) === stableJson(desiredJson)) {
    return { hasDrift: false }
  }

  return {
    hasDrift: true,
    driftKind: 'shape',
    currentHash: internalHash(currentProjection),
    desiredHash: row.desired_projection_hash,
  }
}

export function disableManagedBinding(
  store: InterfaceStore,
  projectionId: string,
  _reason: 'source_missing'
): { binding: InterfaceBinding; provenance: ManagedBindingProvenanceRecord } {
  return store.runInTransaction(() => {
    const provenance = getManagedBindingProvenance(store, projectionId)
    if (provenance === undefined) {
      throw new Error(`managed binding provenance not found: ${projectionId}`)
    }

    store.sqlite
      .prepare(
        "UPDATE interface_bindings SET status = 'disabled', updated_at = ? WHERE binding_id = ?"
      )
      .run(new Date().toISOString(), provenance.bindingId)
    const binding = store.bindings.getById(provenance.bindingId)
    if (binding === undefined) {
      throw new Error(`managed binding not found after disable: ${provenance.bindingId}`)
    }

    const row = getProvenanceRow(store, projectionId)
    const desiredJson =
      row === undefined ? {} : (JSON.parse(row.desired_projection_json) as Record<string, unknown>)
    store.sqlite
      .prepare(
        `UPDATE managed_resource_provenance_interface
            SET state = 'disabled',
                projection_row_fingerprint = ?,
                projection_row_updated_at = ?,
                updated_at = ?
          WHERE projection_id = ?`
      )
      .run(
        internalHash(liveProjectionFromBinding(binding, desiredJson)),
        binding.updatedAt,
        new Date().toISOString(),
        projectionId
      )

    const updated = getManagedBindingProvenance(store, projectionId)
    if (updated === undefined) {
      throw new Error(`managed binding provenance not found after disable: ${projectionId}`)
    }
    return { binding, provenance: updated }
  })
}
