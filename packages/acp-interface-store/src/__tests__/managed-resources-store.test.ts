/**
 * Phase C RED tests — Phase D Store Layer: managed-resource provenance for interface bindings.
 *
 * STATUS: INTENTIONALLY FAILING — Phase D (managed-resources.ts) has not yet been implemented.
 * These tests will go GREEN when Phase D delivers:
 *   - managed_resource_provenance_interface table in acp-interface.db (same-transaction with bindings)
 *   - applyManagedBinding / getManagedBindingProvenance / detectBindingDrift /
 *     disableManagedBinding exported from managed-resources.ts
 *
 * Wire input: canonical ASP plan fixture resource[1] (interface-binding: discord-smoke).
 * Layer: these tests cover the STORE layer only; Phase E tests are in
 *   tests/conformance/managed-resources/apply-status.test.ts
 *
 * Invariants tested (from T-04868 / T-04883):
 *   - Same-transaction provenance (binding row + provenance row atomic)
 *   - Provenance uniqueness constraints
 *   - Idempotent reapply (noop, stable bindingId)
 *   - Unmanaged collision fail-closed (UNMANAGED_COLLISION)
 *   - Differently-managed collision fail-closed (FOREIGN_MANAGED_COLLISION)
 *   - Stale adoption rejection (projectionId matches, projectionPk mismatches)
 *   - Drift detection (shape/hash comparison)
 *   - Disable-only deletion preserving delivery history
 */
import { describe, expect, test } from 'bun:test'

import { openInterfaceStore } from '../index.js'
// Phase D will create this module. Until then, this import fails at module resolution,
// making all tests in this file RED. When managed-resources.ts is created and exports
// these symbols, the tests will run and (when correctly implemented) go GREEN.
import {
  type ApplyManagedBindingInput,
  type ManagedBindingProvenanceRecord,
  applyManagedBinding,
  detectBindingDrift,
  disableManagedBinding,
  getManagedBindingProvenance,
} from '../managed-resources.js'

// ------------------------------------------------------------------
// Canonical wire inputs from the frozen ASP plan fixture v1
// ------------------------------------------------------------------

const NOW = '2026-06-17T22:00:00.000Z'
const OWNER_SCOPE = 'agent:smokey:project:agent-spaces'

/** Interface-binding resource — matches expected-plan.json resource[1]. */
const DISCORD_BINDING: ApplyManagedBindingInput = {
  projectionId:
    'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke',
  projectionPk: 'agent-smokey.discord-smoke',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'discord-smoke',
  sourcePath: 'agents/smokey/channels/discord-smoke.toml',
  sourceHash:
    'sha256-canonical-json/v1:ea43e293de6565579fd5ffdf2fb9c3e9eea8ea7d1a8213c7b6d3cb3cfd737870',
  desiredProjectionHash:
    'sha256-canonical-json/v1:6f6bdc51f0ceb99fc7450ac1e25a215440a0e63e4eecbed67dba3ca807869dd0',
  desiredJson: {
    kind: 'interface-binding',
    bindingId: 'agent-smokey.discord-smoke',
    gatewayId: 'acp-discord-smoke',
    gatewayType: 'discord',
    conversationRef: 'channel:1501224513390772224',
    threadRef: 'thread:1501224513390772225',
    routing: {
      projectId: 'agent-spaces',
      agentId: 'smokey',
      taskId: 'primary',
      roleName: 'coordinator',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'agent:smokey:project:agent-spaces:task:primary~main',
    },
    status: 'active',
  },
  resourceKind: 'interface-binding',
  now: NOW,
}

/** A second distinct binding used for multi-resource tests. */
const ALT_BINDING: ApplyManagedBindingInput = {
  projectionId:
    'agent-directory:agent:smokey:project:agent-spaces:interface-binding:ios-smoke',
  projectionPk: 'agent-smokey.ios-smoke',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'ios-smoke',
  sourcePath: 'agents/smokey/channels/ios-smoke.toml',
  sourceHash: 'sha256-canonical-json/v1:' + '1'.repeat(64),
  desiredProjectionHash: 'sha256-canonical-json/v1:' + '2'.repeat(64),
  desiredJson: {
    kind: 'interface-binding',
    bindingId: 'agent-smokey.ios-smoke',
    gatewayId: 'acp-ios',
    gatewayType: 'ios',
    conversationRef: 'session:ios-primary',
    routing: {
      projectId: 'agent-spaces',
      agentId: 'smokey',
      taskId: 'primary',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'agent:smokey:project:agent-spaces:task:primary~main',
    },
    status: 'active',
  },
  resourceKind: 'interface-binding',
  now: NOW,
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function freshStore() {
  return openInterfaceStore({ dbPath: ':memory:' })
}

// Suppress unused-type lint on type imports used only in type assertions
function typeAssert<_T>(_v: _T): void {}
typeAssert<ManagedBindingProvenanceRecord | undefined>(undefined)

// ==================================================================
// Provenance table schema
// ==================================================================

describe('managed_resource_provenance_interface schema (Phase D — store layer)', () => {
  test('managed_resource_provenance_interface table exists after Phase D migration', () => {
    const store = freshStore()
    const tables = store.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
    expect(tables.map((r) => r.name)).toContain('managed_resource_provenance_interface')
  })

  test('managed_resource_provenance_interface has required columns', () => {
    const store = freshStore()
    const cols = store.sqlite
      .prepare("PRAGMA table_info('managed_resource_provenance_interface')")
      .all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    for (const required of [
      'provenance_id',
      'projection_id',
      'projection_pk',
      'binding_id',
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
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='managed_resource_provenance_interface'"
      )
      .all() as Array<{ name: string; sql: string }>
    const hasUnique = indexes.some(
      (i) =>
        i.sql?.toUpperCase().includes('UNIQUE') &&
        i.sql?.toLowerCase().includes('projection_id')
    )
    expect(hasUnique).toBe(true)
  })
})

// ==================================================================
// Same-transaction provenance
// ==================================================================

describe('same-transaction provenance (Phase D invariant)', () => {
  test('applyManagedBinding creates a binding row and a provenance row atomically', () => {
    const store = freshStore()
    const result = applyManagedBinding(store, DISCORD_BINDING)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    // Binding row must exist
    const binding = store.bindings.findById(result.binding.bindingId)
    expect(binding).toBeDefined()
    expect(binding?.bindingId).toBe('agent-smokey.discord-smoke')
    expect(binding?.gatewayType).toBe('discord')

    // Provenance row must exist in the SAME store (written in the same transaction)
    const prov = getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)
    expect(prov).toBeDefined()
    expect(prov?.bindingId).toBe(result.binding.bindingId)
    expect(prov?.projectionId).toBe(DISCORD_BINDING.projectionId)
    expect(prov?.projectionPk).toBe(DISCORD_BINDING.projectionPk)
    expect(prov?.sourceHash).toBe(DISCORD_BINDING.sourceHash)
    expect(prov?.desiredProjectionHash).toBe(DISCORD_BINDING.desiredProjectionHash)
    expect(prov?.resourceKind).toBe('interface-binding')
    expect(prov?.managedBy).toBe('agent-directory')
    expect(prov?.state).toBe('active')
  })

  test('failed apply due to collision does not leave an orphaned provenance row', () => {
    const store = freshStore()
    // Pre-seed an unmanaged binding at the same bindingId
    store.bindings.create({
      bindingId: 'agent-smokey.discord-smoke',
      gatewayId: 'acp-discord-smoke',
      gatewayType: 'discord',
      conversationRef: 'channel:1501224513390772224',
      threadRef: 'thread:1501224513390772225',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'agent:smokey:project:agent-spaces:task:primary~main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = applyManagedBinding(store, DISCORD_BINDING)
    expect(result.outcome).toBe('collision')

    const prov = getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)
    expect(prov).toBeUndefined()
  })
})

// ==================================================================
// Provenance uniqueness constraints
// ==================================================================

describe('provenance uniqueness constraints (Phase D invariant)', () => {
  test('two resources with the same projectionId but different projectionPk → stale_adoption_rejected', () => {
    const store = freshStore()
    expect(applyManagedBinding(store, DISCORD_BINDING).outcome).toBe('created')

    const impostor: ApplyManagedBindingInput = {
      ...DISCORD_BINDING,
      projectionPk: 'agent-smokey.discord-smoke-v2',
      desiredJson: { ...DISCORD_BINDING.desiredJson, bindingId: 'agent-smokey.discord-smoke-v2' },
    }
    const result = applyManagedBinding(store, impostor)
    expect(result.outcome).toBe('stale_adoption_rejected')
  })

  test('two distinct projectionIds with distinct projectionPks are both accepted', () => {
    const store = freshStore()
    expect(applyManagedBinding(store, DISCORD_BINDING).outcome).toBe('created')
    expect(applyManagedBinding(store, ALT_BINDING).outcome).toBe('created')
  })
})

// ==================================================================
// Idempotent reapply
// ==================================================================

describe('idempotent reapply (Phase D invariant)', () => {
  test('applying the same resource twice produces noop on the second call', () => {
    const store = freshStore()
    expect(applyManagedBinding(store, DISCORD_BINDING).outcome).toBe('created')
    expect(applyManagedBinding(store, DISCORD_BINDING).outcome).toBe('noop')
  })

  test('reapply preserves the original bindingId (stable projection identity)', () => {
    const store = freshStore()
    const first = applyManagedBinding(store, DISCORD_BINDING)
    if (first.outcome !== 'created') throw new Error(`expected created, got ${first.outcome}`)

    const second = applyManagedBinding(store, DISCORD_BINDING)
    expect(['noop', 'updated']).toContain(second.outcome)
    expect(second.binding.bindingId).toBe(first.binding.bindingId)
  })

  test('reapply with changed desiredJson produces "updated" outcome and updates provenance hash', () => {
    const store = freshStore()
    applyManagedBinding(store, DISCORD_BINDING)

    const changed: ApplyManagedBindingInput = {
      ...DISCORD_BINDING,
      sourceHash: 'sha256-canonical-json/v1:' + 'a'.repeat(64),
      desiredProjectionHash: 'sha256-canonical-json/v1:' + 'b'.repeat(64),
      desiredJson: {
        ...DISCORD_BINDING.desiredJson,
        status: 'disabled',
      },
    }
    const result = applyManagedBinding(store, changed)
    expect(result.outcome).toBe('updated')

    const prov = getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)
    expect(prov?.desiredProjectionHash).toBe(changed.desiredProjectionHash)
    expect(prov?.sourceHash).toBe(changed.sourceHash)
  })
})

// ==================================================================
// Collision: unmanaged / differently-managed
// ==================================================================

describe('collision fail-closed behavior (Phase D invariant)', () => {
  test('bindingId exists with no provenance → UNMANAGED_COLLISION', () => {
    const store = freshStore()
    store.bindings.create({
      bindingId: 'agent-smokey.discord-smoke',
      gatewayId: 'acp-discord-smoke',
      gatewayType: 'discord',
      conversationRef: 'channel:1501224513390772224',
      threadRef: 'thread:1501224513390772225',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'agent:smokey:project:agent-spaces:task:primary~main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = applyManagedBinding(store, DISCORD_BINDING)
    expect(result.outcome).toBe('collision')
    if (result.outcome !== 'collision') return
    expect(result.error.code).toBe('UNMANAGED_COLLISION')
  })

  test('bindingId owned by a different projectionId → FOREIGN_MANAGED_COLLISION', () => {
    const store = freshStore()
    const foreign: ApplyManagedBindingInput = {
      ...DISCORD_BINDING,
      projectionId: 'agent-directory:agent:foreign:project:other:interface-binding:discord-smoke',
      sourceOwnerScopeRef: 'agent:foreign:project:other',
    }
    expect(applyManagedBinding(store, foreign).outcome).toBe('created')

    const result = applyManagedBinding(store, DISCORD_BINDING)
    expect(result.outcome).toBe('collision')
    if (result.outcome !== 'collision') return
    expect(result.error.code).toBe('FOREIGN_MANAGED_COLLISION')
  })

  test('collision does not mutate the pre-existing binding row', () => {
    const store = freshStore()
    store.bindings.create({
      bindingId: 'agent-smokey.discord-smoke',
      gatewayId: 'acp-discord-smoke',
      gatewayType: 'discord',
      conversationRef: 'channel:1501224513390772224',
      threadRef: 'thread:1501224513390772225',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'agent:smokey:project:agent-spaces:task:primary~main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })

    applyManagedBinding(store, DISCORD_BINDING)

    const existing = store.bindings.findById('agent-smokey.discord-smoke')
    // Gateway type should still be what was set by the unmanaged create
    expect(existing?.gatewayType).toBe('discord')
    // No provenance row created
    expect(getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)).toBeUndefined()
  })
})

// ==================================================================
// Stale adoption failure
// ==================================================================

describe('stale adoption failure (Phase D invariant)', () => {
  test('projectionId matches existing provenance but projectionPk mismatches → stale_adoption_rejected', () => {
    const store = freshStore()
    applyManagedBinding(store, DISCORD_BINDING)

    const stale: ApplyManagedBindingInput = {
      ...DISCORD_BINDING,
      projectionPk: 'agent-smokey.discord-smoke-renamed',
      desiredJson: { ...DISCORD_BINDING.desiredJson, bindingId: 'agent-smokey.discord-smoke-renamed' },
    }
    const result = applyManagedBinding(store, stale)
    expect(result.outcome).toBe('stale_adoption_rejected')
    if (result.outcome !== 'stale_adoption_rejected') return
    expect(result.error.code).toBe('STALE_ADOPTION')
  })
})

// ==================================================================
// Drift detection
// ==================================================================

describe('drift detection (Phase D invariant)', () => {
  test('detectBindingDrift returns no drift for a freshly applied binding', () => {
    const store = freshStore()
    applyManagedBinding(store, DISCORD_BINDING)
    const drift = detectBindingDrift(store, DISCORD_BINDING.projectionId)
    expect(drift.hasDrift).toBe(false)
  })

  test('detectBindingDrift reports drift after out-of-band mutation', () => {
    const store = freshStore()
    const created = applyManagedBinding(store, DISCORD_BINDING)
    if (created.outcome !== 'created') throw new Error('expected created')

    // Operator changes status directly via SQL (outside managed-resources — simulates a manual edit)
    store.sqlite
      .prepare(
        "UPDATE interface_bindings SET status = 'disabled', updated_at = ? WHERE binding_id = ?"
      )
      .run(NOW, created.binding.bindingId)

    const drift = detectBindingDrift(store, DISCORD_BINDING.projectionId)
    expect(drift.hasDrift).toBe(true)
    expect(drift.driftKind).toBeDefined()
  })

  test('detectBindingDrift for unknown projectionId returns hasDrift=false', () => {
    const store = freshStore()
    const drift = detectBindingDrift(store, 'agent-directory:nonexistent')
    expect(drift.hasDrift).toBe(false)
  })
})

// ==================================================================
// Disable-only: missing source preserves delivery history
// ==================================================================

describe('disable-only missing-source behavior (Phase D invariant)', () => {
  test('disableManagedBinding sets status=disabled but does NOT delete the binding', () => {
    const store = freshStore()
    const created = applyManagedBinding(store, DISCORD_BINDING)
    if (created.outcome !== 'created') throw new Error('expected created')

    const { binding: disabled } = disableManagedBinding(
      store,
      DISCORD_BINDING.projectionId,
      'source_missing'
    )
    expect(disabled.status).toBe('disabled')

    // Binding still exists — not deleted — delivery history preserved
    const fetched = store.bindings.findById(disabled.bindingId)
    expect(fetched).toBeDefined()
    expect(fetched?.status).toBe('disabled')
  })

  test('disableManagedBinding marks provenance.state = disabled', () => {
    const store = freshStore()
    applyManagedBinding(store, DISCORD_BINDING)
    disableManagedBinding(store, DISCORD_BINDING.projectionId, 'source_missing')

    const prov = getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)
    expect(prov?.state).toBe('disabled')
  })

  test('disabling a managed binding does NOT purge delivery request rows', () => {
    const store = freshStore()
    const created = applyManagedBinding(store, DISCORD_BINDING)
    if (created.outcome !== 'created') throw new Error('expected created')

    // Seed a delivery request row directly (simulates prior message delivery activity).
    // We insert at the SQL layer because the full enqueue API requires a complete actor/route context
    // that is not relevant to what this test validates (that disable doesn't purge history).
    store.sqlite
      .prepare(
        `INSERT INTO delivery_requests (
           delivery_request_id, gateway_id, binding_id, scope_ref, lane_ref,
           conversation_ref, body_kind, body_text, status,
           actor_kind, actor_id, actor_stamp, created_at, updated_at
         ) VALUES (
           'dr_smoke_1', 'acp-discord-smoke', 'agent-smokey.discord-smoke',
           'agent:smokey:project:agent-spaces:task:primary',
           'agent:smokey:project:agent-spaces:task:primary~main',
           'channel:1501224513390772224', 'text', 'smoke test message',
           'queued', 'agent', 'smokey', 'v1', ?, ?
         )`
      )
      .run(NOW, NOW)

    disableManagedBinding(store, DISCORD_BINDING.projectionId, 'source_missing')

    // Delivery rows must still exist — disable must NOT purge delivery history
    const rows = store.sqlite
      .prepare(
        "SELECT binding_id FROM delivery_requests WHERE binding_id = 'agent-smokey.discord-smoke'"
      )
      .all() as Array<{ binding_id: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})
