/**
 * RED TESTS — Phase 4a: WrkfParticipantCapturesRepo (T-02754)
 *
 * Table: wrkf_participant_captures
 *   capture_key TEXT PRIMARY KEY
 *   task_id TEXT NOT NULL
 *   workflow_ref TEXT NOT NULL
 *   wrkf_run_id TEXT NOT NULL
 *   body_hash TEXT NOT NULL
 *   evidence_ids_json TEXT NOT NULL   -- JSON array of evidence IDs
 *   obligation_ids_json TEXT NOT NULL -- JSON array of obligation IDs
 *   status TEXT NOT NULL              -- 'pending' | 'completed'
 *   created_at TEXT NOT NULL
 *   updated_at TEXT NOT NULL
 *
 * All tests in this file FAIL NOW — the repo, migration, and store property
 * do not exist yet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT
 *
 * 1. packages/acp-state-store/src/repos/wrkf-participant-captures-repo.ts
 *    Export WrkfParticipantCapturesRepo class with:
 *
 *    get(captureKey: string): WrkfParticipantCaptureRecord | undefined
 *      — returns the stored record if it exists, undefined otherwise.
 *
 *    setOrConflict(input: {
 *      captureKey: string
 *      taskId: string
 *      workflowRef: string
 *      wrkfRunId: string
 *      bodyHash: string
 *      evidenceIds: string[]
 *      obligationIds: string[]
 *    }): { state: 'created'; record: WrkfParticipantCaptureRecord }
 *       | { state: 'replay'; record: WrkfParticipantCaptureRecord }
 *       | { state: 'conflict' }
 *      — Atomically:
 *          no existing row → INSERT, return { state: 'created', record }
 *          existing + same body_hash → return { state: 'replay', record }
 *          existing + different body_hash → return { state: 'conflict' }
 *
 *    complete(input: {
 *      captureKey: string
 *      evidenceIds: string[]
 *      obligationIds: string[]
 *    }): WrkfParticipantCaptureRecord
 *      — UPDATE status='completed', evidence_ids_json, obligation_ids_json, updated_at
 *
 * 2. Export WrkfParticipantCaptureRecord type:
 *    { captureKey, taskId, workflowRef, wrkfRunId, bodyHash, evidenceIds, obligationIds,
 *      status, createdAt, updatedAt }
 *
 * 3. packages/acp-state-store/src/open-store.ts
 *    Add migration for wrkf_participant_captures table (additive).
 *    Add wrkfParticipantCaptures: WrkfParticipantCapturesRepo to AcpStateStore + factory.
 *
 * 4. packages/acp-state-store/src/index.ts
 *    Export WrkfParticipantCapturesRepo and WrkfParticipantCaptureRecord.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'

// Local type mirror for test assertions (not imported — file doesn't exist yet)
type WrkfParticipantCaptureRecord = {
  captureKey: string
  taskId: string
  workflowRef: string
  wrkfRunId: string
  bodyHash: string
  evidenceIds: string[]
  obligationIds: string[]
  status: 'pending' | 'completed'
  createdAt: string
  updatedAt: string
}

type SetOrConflictResult =
  | { state: 'created'; record: WrkfParticipantCaptureRecord }
  | { state: 'replay'; record: WrkfParticipantCaptureRecord }
  | { state: 'conflict' }

type WrkfParticipantCapturesRepo = {
  get(captureKey: string): WrkfParticipantCaptureRecord | undefined
  setOrConflict(input: {
    captureKey: string
    taskId: string
    workflowRef: string
    wrkfRunId: string
    bodyHash: string
    evidenceIds: string[]
    obligationIds: string[]
  }): SetOrConflictResult
  complete(input: {
    captureKey: string
    evidenceIds: string[]
    obligationIds: string[]
  }): WrkfParticipantCaptureRecord
}

function getRepo(store: ReturnType<typeof openAcpStateStore>): WrkfParticipantCapturesRepo {
  // FAILS until open-store.ts exposes wrkfParticipantCaptures
  const repo = (store as unknown as Record<string, unknown>)['wrkfParticipantCaptures']
  if (repo === undefined) {
    throw new Error(
      'store.wrkfParticipantCaptures is undefined — WrkfParticipantCapturesRepo not yet added to AcpStateStore'
    )
  }
  return repo as WrkfParticipantCapturesRepo
}

const BASE = {
  captureKey: 'cap_T-09990_wrkf-run-001_evidence-phase',
  taskId: 'T-09990',
  workflowRef: 'canonical-flow@v1',
  wrkfRunId: 'wrkf-run-cap-001',
  bodyHash: 'sha256:cap-body-hash-aaa',
  evidenceIds: ['ev_001', 'ev_002'],
  obligationIds: ['obl_001'],
}

// ─── Section 1: get — before any record ──────────────────────────────────────

describe('WrkfParticipantCapturesRepo.get — before any record (Phase 4a red)', () => {
  test('[RED] get returns undefined when capture_key does not exist', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.get('cap_nonexistent')
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

// ─── Section 2: setOrConflict — created path ─────────────────────────────────

describe('WrkfParticipantCapturesRepo.setOrConflict — created (Phase 4a red)', () => {
  test('[RED] first call returns { state: created, record }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.setOrConflict(BASE)
      expect(result.state).toBe('created')
    } finally {
      store.close()
    }
  })

  test('[RED] created record carries all input fields', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.setOrConflict(BASE) as Extract<SetOrConflictResult, { state: 'created' }>
      expect(result.record.captureKey).toBe(BASE.captureKey)
      expect(result.record.taskId).toBe(BASE.taskId)
      expect(result.record.workflowRef).toBe(BASE.workflowRef)
      expect(result.record.wrkfRunId).toBe(BASE.wrkfRunId)
      expect(result.record.bodyHash).toBe(BASE.bodyHash)
      expect(result.record.evidenceIds).toEqual(BASE.evidenceIds)
      expect(result.record.obligationIds).toEqual(BASE.obligationIds)
    } finally {
      store.close()
    }
  })

  test('[RED] created record has status=pending initially', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.setOrConflict(BASE) as Extract<SetOrConflictResult, { state: 'created' }>
      expect(result.record.status).toBe('pending')
    } finally {
      store.close()
    }
  })

  test('[RED] get after setOrConflict returns the stored record', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const record = repo.get(BASE.captureKey)
      expect(record).toBeDefined()
      expect(record?.captureKey).toBe(BASE.captureKey)
      expect(record?.evidenceIds).toEqual(BASE.evidenceIds)
      expect(record?.obligationIds).toEqual(BASE.obligationIds)
    } finally {
      store.close()
    }
  })

  test('[RED] different captureKeys are independent', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.setOrConflict({ ...BASE, captureKey: 'cap_key_one' })
      const r2 = repo.setOrConflict({ ...BASE, captureKey: 'cap_key_two' })
      expect(r1.state).toBe('created')
      expect(r2.state).toBe('created')
      expect(repo.get('cap_key_one')).toBeDefined()
      expect(repo.get('cap_key_two')).toBeDefined()
    } finally {
      store.close()
    }
  })
})

// ─── Section 3: setOrConflict — replay (get-before-write) ────────────────────

describe('WrkfParticipantCapturesRepo.setOrConflict — replay (Phase 4a red)', () => {
  test('[RED] second call with same captureKey + same bodyHash returns { state: replay }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const r2 = repo.setOrConflict(BASE)
      expect(r2.state).toBe('replay')
    } finally {
      store.close()
    }
  })

  test('[RED] replay record carries the original evidenceIds and obligationIds', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const r2 = repo.setOrConflict(BASE) as Extract<SetOrConflictResult, { state: 'replay' }>
      expect(r2.record.evidenceIds).toEqual(BASE.evidenceIds)
      expect(r2.record.obligationIds).toEqual(BASE.obligationIds)
    } finally {
      store.close()
    }
  })

  test('[RED] replay after complete returns completed record with final evidenceIds', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const finalEvidenceIds = ['ev_001', 'ev_002', 'ev_003']
      repo.complete({ captureKey: BASE.captureKey, evidenceIds: finalEvidenceIds, obligationIds: [] })

      const r2 = repo.setOrConflict(BASE) as Extract<SetOrConflictResult, { state: 'replay' }>
      expect(r2.state).toBe('replay')
      expect(r2.record.status).toBe('completed')
      expect(r2.record.evidenceIds).toEqual(finalEvidenceIds)
    } finally {
      store.close()
    }
  })

  test('[RED] only one row exists after multiple setOrConflict calls for same key', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const first = repo.get(BASE.captureKey)

      repo.setOrConflict(BASE)
      repo.setOrConflict(BASE)
      const after = repo.get(BASE.captureKey)
      // createdAt must not change on replay
      expect(after?.createdAt).toBe(first?.createdAt)
    } finally {
      store.close()
    }
  })
})

// ─── Section 4: setOrConflict — conflict (body_hash mismatch) ────────────────

describe('WrkfParticipantCapturesRepo.setOrConflict — conflict (Phase 4a red)', () => {
  test('[RED] same captureKey + different bodyHash returns { state: conflict }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const conflict = repo.setOrConflict({ ...BASE, bodyHash: 'sha256:DIFFERENT' })
      expect(conflict.state).toBe('conflict')
    } finally {
      store.close()
    }
  })

  test('[RED] conflict does not overwrite the existing bodyHash', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      repo.setOrConflict({ ...BASE, bodyHash: 'sha256:DIFFERENT' }) // conflict

      const record = repo.get(BASE.captureKey)
      expect(record?.bodyHash).toBe(BASE.bodyHash)
    } finally {
      store.close()
    }
  })
})

// ─── Section 5: complete ──────────────────────────────────────────────────────

describe('WrkfParticipantCapturesRepo.complete (Phase 4a red)', () => {
  test('[RED] complete sets status=completed and updates evidenceIds/obligationIds', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      const finalEvIds = ['ev_001', 'ev_002', 'ev_003']
      const finalOblIds = ['obl_001', 'obl_002']
      const record = repo.complete({
        captureKey: BASE.captureKey,
        evidenceIds: finalEvIds,
        obligationIds: finalOblIds,
      })
      expect(record.status).toBe('completed')
      expect(record.evidenceIds).toEqual(finalEvIds)
      expect(record.obligationIds).toEqual(finalOblIds)
    } finally {
      store.close()
    }
  })

  test('[RED] get after complete returns the completed record', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.setOrConflict(BASE)
      repo.complete({
        captureKey: BASE.captureKey,
        evidenceIds: ['ev_final'],
        obligationIds: [],
      })
      const record = repo.get(BASE.captureKey)
      expect(record?.status).toBe('completed')
      expect(record?.evidenceIds).toEqual(['ev_final'])
    } finally {
      store.close()
    }
  })
})
