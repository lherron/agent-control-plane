import { describe, expect, test } from 'bun:test'

import {
  type EvidenceRecord,
  projectEffectRecord,
  projectEvidenceRecord,
  projectNextActionResponse,
  projectObligationRecord,
} from './projections.js'

describe('wrkf projections', () => {
  test('projects revision/contextHash from next.instance and parses state.status/phase', () => {
    const projected = projectNextActionResponse({
      instance: {
        id: 'wfi_123',
        taskRef: 'wrkq:T-02032',
        template: { id: 'pbc-progressive-refinement', version: '5' },
        state: { status: 'active', phase: 'pressure' },
        revision: 7,
        contextHash: 'sha256:abc123',
      },
      actions: [{ transition: 'finalize_ready_pbc', role: 'agent' }],
      blockedTransitions: [{ transition: 'ask_clarification', reason: 'wrong state' }],
      openObligations: [{ id: 'obl_1', kind: 'patch_decision', status: 'open' }],
      pendingEffects: [{ id: 'eff_1', kind: 'set_task_state', status: 'pending' }],
    })

    expect(projected.instance.id).toBe('wfi_123')
    expect(projected.instance.revision).toBe(7)
    expect(projected.instance.contextHash).toBe('sha256:abc123')
    expect(projected.instance.state).toEqual({ status: 'active', phase: 'pressure' })
    expect(projected.actions).toHaveLength(1)
    expect(projected.blockedTransitions[0]?.transition).toBe('ask_clarification')
    expect(projected.openObligations[0]?.kind).toBe('patch_decision')
    expect(projected.pendingEffects[0]?.kind).toBe('set_task_state')
  })

  test('accepts missing next arrays as empty arrays', () => {
    const projected = projectNextActionResponse({
      instance: {
        state: { status: 'closed', phase: 'finalized' },
        revision: 12,
      },
    })

    expect(projected.actions).toEqual([])
    expect(projected.blockedTransitions).toEqual([])
    expect(projected.openObligations).toEqual([])
    expect(projected.pendingEffects).toEqual([])
  })

  test('throws clear errors for malformed or missing required next fields', () => {
    expect(() => projectNextActionResponse({})).toThrow('next.instance must be an object')
    expect(() =>
      projectNextActionResponse({
        instance: { state: { status: 'active' }, revision: 1 },
      })
    ).toThrow('next.instance.state.phase must be a non-empty string')
    expect(() =>
      projectNextActionResponse({
        instance: { state: { status: 'active', phase: 'pressure' }, revision: '7' },
      })
    ).toThrow('next.instance.revision must be a number')
    expect(() =>
      projectNextActionResponse({
        instance: { state: { status: 'active', phase: 'pressure' }, revision: 7 },
        actions: {},
      })
    ).toThrow('next.actions must be an array')
  })

  test('projects evidence, obligation, and effect records with raw payload preserved', () => {
    const evidence = projectEvidenceRecord({
      id: 'ev_1',
      kind: 'pressure_pass',
      ref: 'wrkq:T-02032#pressure',
      summary: 'ready',
      facts: { verdict: 'ready' },
      actor: 'agent:pressure-reviewer',
      role: 'agent',
    })
    const obligation = projectObligationRecord({
      id: 'obl_1',
      kind: 'patch_decision',
      status: 'open',
      evidenceId: 'ev_1',
    })
    const effect = projectEffectRecord({
      id: 'eff_1',
      kind: 'set_task_state',
      status: 'pending',
      payload: { kind: 'set_task_state', data: { state: 'completed' } },
      idempotencyKey: 'task-state:T-02032:12:completed',
      revision: 12,
      attempts: 0,
    })

    expect(evidence.facts).toEqual({ verdict: 'ready' })
    expect(evidence.raw['actor']).toBe('agent:pressure-reviewer')
    expect(obligation.evidenceId).toBe('ev_1')
    expect(effect.payload).toEqual({ kind: 'set_task_state', data: { state: 'completed' } })
    expect(effect.raw['idempotencyKey']).toBe('task-state:T-02032:12:completed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1, Deliverable 2 — RED TESTS
// EvidenceRecord exposes data, actor, role as first-class projected fields.
//
// WHY RED:
//   projectEvidenceRecord currently reads only: id, kind, ref, summary, facts.
//   It does NOT read data, actor, or role from the raw record.
//   EvidenceRecord type does NOT include data, actor, or role fields.
//
// WHAT THE IMPL AGENT MUST CHANGE:
//   1. In EvidenceRecord type (~line 46), add:
//        data?: unknown
//        actor?: unknown
//        role?: string | undefined
//   2. In projectEvidenceRecord (~line 128), read and include them:
//        const data = evidence['data']
//        const actor = readOptionalString(evidence, 'actor') ?? evidence['actor']
//        const role = readOptionalString(evidence, 'role')
//        return {
//          ...,
//          ...(data !== undefined ? { data } : {}),
//          ...(actor !== undefined ? { actor } : {}),
//          ...(role !== undefined ? { role } : {}),
//          raw: evidence,
//        }
// ─────────────────────────────────────────────────────────────────────────────

describe('P1-D2: projectEvidenceRecord — data, actor, role as first-class fields', () => {
  // Helper to extract projected fields without TypeScript type errors
  // (the fields don't exist yet in EvidenceRecord — cast through unknown)
  function asExtended(ev: EvidenceRecord): Record<string, unknown> {
    return ev as unknown as Record<string, unknown>
  }

  test('projectEvidenceRecord: data, actor, role all included together', () => {
    const DATA_VAL = { approved: true, timestamp: '2026-06-08T00:00:00Z' }
    const ev = projectEvidenceRecord({
      id: 'ev_d2_004',
      kind: 'approval',
      ref: 'ref://approval',
      summary: 'approved',
      data: DATA_VAL,
      principal_ref: 'agent:approver',
      role: 'approver',
    })
    const ext = asExtended(ev)
    // Pre-existing fields still work
    expect(ev.id).toBe('ev_d2_004')
    expect(ev.kind).toBe('approval')
    expect(ev.ref).toBe('ref://approval')
    expect(ev.summary).toBe('approved')
    // RED: new first-class fields are undefined
    expect(ext['data']).toEqual(DATA_VAL)
    expect(ext['actor']).toBe('agent:approver')
    expect(ext['role']).toBe('approver')
  })

  test('projectEvidenceRecord: data absent → data field not included in output', () => {
    const ev = projectEvidenceRecord({
      id: 'ev_d2_005',
      kind: 'manual',
      ref: 'ref://no-data',
    })
    const ext = asExtended(ev)
    // data not in raw → should not be in projected output
    expect('data' in ext).toBe(false)
    expect('actor' in ext).toBe(false)
  })
})
