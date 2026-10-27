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
  projectionId: 'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke',
  projectionPk: 'agent-smokey.discord-smoke',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'discord-smoke',
  sourcePath: 'agents/smokey/channels/discord-smoke.toml',
  sourceHash:
    'sha256-canonical-json/v1:ea43e293de6565579fd5ffdf2fb9c3e9eea8ea7d1a8213c7b6d3cb3cfd737870',
  desiredProjectionHash:
    'sha256-canonical-json/v1:b831ab64b39dca07221d896c95db24399374ed7e92449ed620758bd3f5ffa81e',
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
      laneRef: 'main',
    },
    status: 'active',
  },
  resourceKind: 'interface-binding',
  now: NOW,
}

/** A second distinct binding used for multi-resource tests. */
const ALT_BINDING: ApplyManagedBindingInput = {
  projectionId: 'agent-directory:agent:smokey:project:agent-spaces:interface-binding:ios-smoke',
  projectionPk: 'agent-smokey.ios-smoke',
  sourceOwnerScopeRef: OWNER_SCOPE,
  resourceName: 'ios-smoke',
  sourcePath: 'agents/smokey/channels/ios-smoke.toml',
  sourceHash: `sha256-canonical-json/v1:${'1'.repeat(64)}`,
  desiredProjectionHash: `sha256-canonical-json/v1:${'2'.repeat(64)}`,
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
      laneRef: 'main',
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
// Same-transaction provenance
// ==================================================================

describe('same-transaction provenance (Phase D invariant)', () => {
  test('applying a new managed binding creates the binding and an active agent-directory provenance record', () => {
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
})

// ==================================================================
// Provenance uniqueness constraints
// ==================================================================

describe('provenance uniqueness constraints (Phase D invariant)', () => {
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
    const first = applyManagedBinding(store, DISCORD_BINDING)
    expect(first.outcome).toBe('created')
    const second = applyManagedBinding(store, DISCORD_BINDING)
    expect(second.outcome).toBe('noop')
    expect(second.binding.bindingId).toBe(first.binding.bindingId)
  })

  test('reapply with changed desiredJson produces "updated" outcome and updates provenance hash', () => {
    const store = freshStore()
    applyManagedBinding(store, DISCORD_BINDING)

    const changed: ApplyManagedBindingInput = {
      ...DISCORD_BINDING,
      sourceHash: `sha256-canonical-json/v1:${'a'.repeat(64)}`,
      desiredProjectionHash: `sha256-canonical-json/v1:${'b'.repeat(64)}`,
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
  test('bindingId exists with no provenance → UNMANAGED_COLLISION, leaving the binding untouched and no provenance', () => {
    const store = freshStore()
    // Seeded fields differ from the managed desiredJson so an overwrite is visible.
    store.bindings.create({
      bindingId: 'agent-smokey.discord-smoke',
      gatewayId: 'acp-discord-smoke',
      gatewayType: 'discord',
      conversationRef: 'channel:unmanaged-original',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const before = store.bindings.findById('agent-smokey.discord-smoke')

    const result = applyManagedBinding(store, DISCORD_BINDING)
    expect(result.outcome).toBe('collision')
    if (result.outcome !== 'collision') return
    expect(result.error.code).toBe('UNMANAGED_COLLISION')
    expect(store.bindings.findById('agent-smokey.discord-smoke')).toEqual(before)
    expect(getManagedBindingProvenance(store, DISCORD_BINDING.projectionId)).toBeUndefined()
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
      desiredJson: {
        ...DISCORD_BINDING.desiredJson,
        bindingId: 'agent-smokey.discord-smoke-renamed',
      },
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
    expect(drift.driftKind).toBe('shape')
  })

  test('detectBindingDrift for unknown projectionId returns hasDrift=false', () => {
    const store = freshStore()
    const drift = detectBindingDrift(store, 'agent-directory:nonexistent')
    expect(drift.hasDrift).toBe(false)
  })
})

// ==================================================================
// role_name persistence (Defect 2 guard — Phase F R2 RED)
// ==================================================================

describe('role_name persistence — Defect 2 guard (Phase F R2 RED)', () => {
  test('a managed binding with routing.roleName persists that role on the binding', () => {
    // DISCORD_BINDING has desiredJson.routing.roleName = "coordinator" while its
    // scopeRef carries no :role: segment, so the role must come from routing.
    const store = freshStore()
    const result = applyManagedBinding(store, DISCORD_BINDING)
    expect(result.outcome).toBe('created')

    const binding = store.bindings.findById('agent-smokey.discord-smoke')
    expect(binding?.roleName).toBe('coordinator')
    expect(binding?.scopeRef).toBe(
      'agent:smokey:project:agent-spaces:task:primary:role:coordinator'
    )
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

    // Prior message delivery activity on the binding.
    store.deliveries.enqueue({
      deliveryRequestId: 'dr_smoke_1',
      gatewayId: 'acp-discord-smoke',
      bindingId: 'agent-smokey.discord-smoke',
      scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
      laneRef: 'main',
      conversationRef: 'channel:1501224513390772224',
      bodyKind: 'text/markdown',
      bodyText: 'smoke test message',
      createdAt: NOW,
    })
    const before = store.deliveries.get('dr_smoke_1')
    expect(before).toBeDefined()

    disableManagedBinding(store, DISCORD_BINDING.projectionId, 'source_missing')

    expect(store.deliveries.get('dr_smoke_1')).toEqual(before)
  })
})
