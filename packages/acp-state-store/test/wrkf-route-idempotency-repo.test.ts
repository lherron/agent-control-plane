/**
 * RED TESTS — Phase 4a: WrkfRouteIdempotencyRepo (T-02754)
 *
 * Table: wrkf_route_idempotency
 *   route TEXT NOT NULL
 *   task_id TEXT NOT NULL
 *   actor_hash TEXT NOT NULL
 *   idempotency_key TEXT NOT NULL
 *   body_hash TEXT NOT NULL
 *   status TEXT NOT NULL  -- 'pending' | 'completed' | 'failed'
 *   response_json TEXT
 *   error_json TEXT
 *   created_at TEXT NOT NULL
 *   updated_at TEXT NOT NULL
 *   PRIMARY KEY (route, task_id, actor_hash, idempotency_key)
 *
 * All tests in this file FAIL NOW — the repo, migration, and store property
 * do not exist yet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT
 *
 * 1. packages/acp-state-store/src/repos/wrkf-route-idempotency-repo.ts
 *    Export WrkfRouteIdempotencyRepo class with:
 *
 *    get(input: { route, taskId, actorHash, idempotencyKey }): WrkfRouteIdempotencyRecord | undefined
 *      — returns the stored record if it exists, undefined otherwise.
 *
 *    admitOrReplay(input: { route, taskId, actorHash, idempotencyKey, bodyHash }):
 *      { state: 'admitted' }
 *      | { state: 'replay'; record: WrkfRouteIdempotencyRecord }
 *      | { state: 'conflict' }
 *      — Atomically:
 *          no existing row → INSERT with status='pending', return { state: 'admitted' }
 *          existing row + same body_hash → return { state: 'replay', record }
 *          existing row + different body_hash → return { state: 'conflict' }
 *
 *    recordResponse(input: { route, taskId, actorHash, idempotencyKey, responseJson }): WrkfRouteIdempotencyRecord
 *      — UPDATE status='completed', response_json, updated_at
 *
 *    recordError(input: { route, taskId, actorHash, idempotencyKey, errorJson }): WrkfRouteIdempotencyRecord
 *      — UPDATE status='failed', error_json, updated_at
 *
 * 2. Export WrkfRouteIdempotencyRecord type:
 *    { route, taskId, actorHash, idempotencyKey, bodyHash, status, responseJson?, errorJson?, createdAt, updatedAt }
 *
 * 3. packages/acp-state-store/src/open-store.ts
 *    Add migration for wrkf_route_idempotency table (additive, CREATE TABLE IF NOT EXISTS).
 *    Add wrkfRouteIdempotency: WrkfRouteIdempotencyRepo to AcpStateStore interface and factory.
 *
 * 4. packages/acp-state-store/src/index.ts
 *    Export WrkfRouteIdempotencyRepo and WrkfRouteIdempotencyRecord.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'

// Helper: access the new repo from the store (undefined until implemented)
type WrkfRouteIdempotencyRecord = {
  route: string
  taskId: string
  actorHash: string
  idempotencyKey: string
  bodyHash: string
  status: 'pending' | 'completed' | 'failed'
  responseJson?: unknown
  errorJson?: unknown
  createdAt: string
  updatedAt: string
}

type AdmitResult =
  | { state: 'admitted' }
  | { state: 'replay'; record: WrkfRouteIdempotencyRecord }
  | { state: 'conflict' }

type WrkfRouteIdempotencyRepo = {
  get(input: {
    route: string
    taskId: string
    actorHash: string
    idempotencyKey: string
  }): WrkfRouteIdempotencyRecord | undefined
  admitOrReplay(input: {
    route: string
    taskId: string
    actorHash: string
    idempotencyKey: string
    bodyHash: string
  }): AdmitResult
  recordResponse(input: {
    route: string
    taskId: string
    actorHash: string
    idempotencyKey: string
    responseJson: unknown
  }): WrkfRouteIdempotencyRecord
  recordError(input: {
    route: string
    taskId: string
    actorHash: string
    idempotencyKey: string
    errorJson: unknown
  }): WrkfRouteIdempotencyRecord
}

function getRepo(store: ReturnType<typeof openAcpStateStore>): WrkfRouteIdempotencyRepo {
  // FAILS until open-store.ts exposes wrkfRouteIdempotency
  const repo = (store as unknown as Record<string, unknown>)['wrkfRouteIdempotency']
  if (repo === undefined) {
    throw new Error(
      'store.wrkfRouteIdempotency is undefined — WrkfRouteIdempotencyRepo not yet added to AcpStateStore'
    )
  }
  return repo as WrkfRouteIdempotencyRepo
}

const BASE_KEY = {
  route: '/wrkf/evidence/capture',
  taskId: 'T-09990',
  actorHash: 'sha256:aabbccdd',
  idempotencyKey: 'idem-route-001',
}

// ─── Section 1: get — lookup before any admit ────────────────────────────────

describe('WrkfRouteIdempotencyRepo.get — before any record (Phase 4a red)', () => {
  test('[RED] get returns undefined when no record exists for the key', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.get(BASE_KEY)
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('[RED] get returns undefined for a different route even after another route is admitted', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const result = repo.get({ ...BASE_KEY, route: '/wrkf/evidence/other-route' })
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

// ─── Section 2: admitOrReplay — fresh path ────────────────────────────────────

describe('WrkfRouteIdempotencyRepo.admitOrReplay — fresh (Phase 4a red)', () => {
  test('[RED] first call returns { state: admitted }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      expect(result.state).toBe('admitted')
    } finally {
      store.close()
    }
  })

  test('[RED] after admitOrReplay, get returns the stored record with status=pending', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const record = repo.get(BASE_KEY)
      expect(record).toBeDefined()
      expect(record?.route).toBe(BASE_KEY.route)
      expect(record?.taskId).toBe(BASE_KEY.taskId)
      expect(record?.actorHash).toBe(BASE_KEY.actorHash)
      expect(record?.idempotencyKey).toBe(BASE_KEY.idempotencyKey)
      expect(record?.bodyHash).toBe('hash-aaa')
      expect(record?.status).toBe('pending')
    } finally {
      store.close()
    }
  })

  test('[RED] different keys (different idempotencyKey) are independent — each gets admitted as fresh', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admitOrReplay({
        ...BASE_KEY,
        idempotencyKey: 'key-one',
        bodyHash: 'hash-aaa',
      })
      const r2 = repo.admitOrReplay({
        ...BASE_KEY,
        idempotencyKey: 'key-two',
        bodyHash: 'hash-bbb',
      })
      expect(r1.state).toBe('admitted')
      expect(r2.state).toBe('admitted')
    } finally {
      store.close()
    }
  })
})

// ─── Section 3: admitOrReplay — replay path ───────────────────────────────────

describe('WrkfRouteIdempotencyRepo.admitOrReplay — replay (Phase 4a red)', () => {
  test('[RED] second call with same key + same body_hash returns { state: replay }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const r2 = repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      expect(r2.state).toBe('replay')
    } finally {
      store.close()
    }
  })

  test('[RED] replay result carries the stored record', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const r2 = repo.admitOrReplay({
        ...BASE_KEY,
        bodyHash: 'hash-aaa',
      }) as Extract<AdmitResult, { state: 'replay' }>
      expect(r2.record).toBeDefined()
      expect(r2.record.bodyHash).toBe('hash-aaa')
      expect(r2.record.idempotencyKey).toBe(BASE_KEY.idempotencyKey)
    } finally {
      store.close()
    }
  })

  test('[RED] replay after recordResponse includes the recorded response in the replay record', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      repo.recordResponse({ ...BASE_KEY, responseJson: { ok: true, evidenceId: 'ev_001' } })

      const r2 = repo.admitOrReplay({
        ...BASE_KEY,
        bodyHash: 'hash-aaa',
      }) as Extract<AdmitResult, { state: 'replay' }>
      expect(r2.state).toBe('replay')
      expect(r2.record.status).toBe('completed')
      expect(r2.record.responseJson).toEqual({ ok: true, evidenceId: 'ev_001' })
    } finally {
      store.close()
    }
  })

  test('[RED] only one row exists after multiple replays of the same key', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      // get should return exactly one record (not multiple)
      const record = repo.get(BASE_KEY)
      expect(record).toBeDefined()
      // createdAt must not change across replays
      const first = record?.createdAt
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const after = repo.get(BASE_KEY)
      expect(after?.createdAt).toBe(first)
    } finally {
      store.close()
    }
  })
})

// ─── Section 4: admitOrReplay — conflict path ─────────────────────────────────

describe('WrkfRouteIdempotencyRepo.admitOrReplay — conflict (Phase 4a red)', () => {
  test('[RED] same key + different body_hash returns { state: conflict }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-original' })
      const conflict = repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-DIFFERENT' })
      expect(conflict.state).toBe('conflict')
    } finally {
      store.close()
    }
  })

  test('[RED] conflict does not mutate the existing record (body_hash unchanged)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-original' })
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-DIFFERENT' }) // conflict

      const record = repo.get(BASE_KEY)
      expect(record?.bodyHash).toBe('hash-original')
    } finally {
      store.close()
    }
  })
})

// ─── Section 5: recordResponse ────────────────────────────────────────────────

describe('WrkfRouteIdempotencyRepo.recordResponse (Phase 4a red)', () => {
  test('[RED] recordResponse sets status=completed and stores responseJson', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const record = repo.recordResponse({
        ...BASE_KEY,
        responseJson: { evidenceId: 'ev_capture_001' },
      })
      expect(record.status).toBe('completed')
      expect(record.responseJson).toEqual({ evidenceId: 'ev_capture_001' })
    } finally {
      store.close()
    }
  })

  test('[RED] get after recordResponse returns the completed record', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      repo.recordResponse({ ...BASE_KEY, responseJson: { ok: true } })
      const record = repo.get(BASE_KEY)
      expect(record?.status).toBe('completed')
      expect(record?.responseJson).toEqual({ ok: true })
    } finally {
      store.close()
    }
  })
})

// ─── Section 6: recordError ───────────────────────────────────────────────────

describe('WrkfRouteIdempotencyRepo.recordError (Phase 4a red)', () => {
  test('[RED] recordError sets status=failed and stores errorJson', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admitOrReplay({ ...BASE_KEY, bodyHash: 'hash-aaa' })
      const record = repo.recordError({ ...BASE_KEY, errorJson: { code: 'EVIDENCE_REJECTED' } })
      expect(record.status).toBe('failed')
      expect(record.errorJson).toEqual({ code: 'EVIDENCE_REJECTED' })
    } finally {
      store.close()
    }
  })
})
