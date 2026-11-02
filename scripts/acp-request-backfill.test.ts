import { describe, expect, test } from 'bun:test'
import { type WorkClient, WorkRpcError } from '@wrkq/client'
import {
  BACKFILL_PRINCIPAL,
  BackfillFailure,
  applyBackfill,
  main,
  planBackfill,
  validateManifest,
} from './acp-request-backfill.js'

function fixture() {
  const tasks = new Map<
    string,
    { id: string; uuid: string; etag: number; state: string; meta: Record<string, unknown> }
  >()
  const exts = new Map<string, { body: Record<string, unknown>; etag: number }>()
  const events = new Map<string, unknown>()
  const calls: string[] = []
  let failure: 'before-put' | 'after-put' | 'before-event' | 'after-event' | 'read' | undefined
  function add(id: string, rev: number, extRev?: number) {
    tasks.set(id, {
      id,
      uuid: `uuid-${id}`,
      etag: 2,
      state: 'completed',
      meta: { acp: { request: { rev } } },
    })
    if (extRev !== undefined) exts.set(id, { body: { rev: extRev }, etag: 3 })
  }
  const client = {
    wrkq: {
      task: {
        list: async (args: {
          cursor?: string
          subtasks: boolean
          includeDeleted: boolean
          state: string[]
          sort: string
        }) => {
          expect(args.subtasks).toBe(true)
          expect(args.includeDeleted).toBe(true)
          expect(args.state).toContain('deleted')
          expect(args.state).toContain('archived')
          expect(args.sort).toBe('id')
          calls.push(`page:${args.cursor ?? 'first'}`)
          const rows = [...tasks.values()]
          return args.cursor
            ? { items: rows.slice(1) }
            : { items: rows.slice(0, 1), nextCursor: 'second' }
        },
        show: async ({ task }: { task: string }) => tasks.get(task),
      },
      ext: {
        show: async ({ subject }: { subject: { task: string } }) => {
          if (failure === 'read') throw new Error('owner unreachable')
          const ext = exts.get(subject.task)
          if (!ext)
            throw new WorkRpcError({
              code: -32004,
              message: 'not found',
              data: { code: 'WRKQ_NOT_FOUND' },
            })
          return { ext }
        },
        put: async (args: {
          subject: { task: string }
          body: Record<string, unknown>
          ifMatch: number
          principalRef: string
        }) => {
          expect(args.principalRef).toBe(BACKFILL_PRINCIPAL)
          if (failure === 'before-put') {
            failure = undefined
            throw new Error('put refused')
          }
          const old = exts.get(args.subject.task)
          expect(args.ifMatch).toBe(old?.etag ?? 0)
          const ext = { body: args.body, etag: (old?.etag ?? 0) + 1 }
          exts.set(args.subject.task, ext)
          calls.push(`put:${args.subject.task}`)
          if (failure === 'after-put') {
            failure = undefined
            throw new Error('put answer lost')
          }
          return { ext }
        },
      },
      projectEvent: {
        post: async (args: {
          idempotencyKey: string
          principalRef: string
          attributes: Record<string, string>
        }) => {
          expect(args.principalRef).toBe(BACKFILL_PRINCIPAL)
          if (failure === 'before-event') {
            failure = undefined
            throw new Error('event refused')
          }
          const created = !events.has(args.idempotencyKey)
          if (created) events.set(args.idempotencyKey, args)
          calls.push(`event:${args.idempotencyKey}`)
          if (failure === 'after-event') {
            failure = undefined
            throw new Error('event answer lost')
          }
          return { uuid: args.idempotencyKey, created }
        },
      },
    },
  } as unknown as WorkClient
  return {
    client,
    add,
    tasks,
    exts,
    events,
    calls,
    fail: (kind: typeof failure) => {
      failure = kind
    },
  }
}

describe('ACP manifest-bound backfill', () => {
  test('full cursor census, named closed unassigned rows, max rule, read-only', async () => {
    const f = fixture()
    f.add('T-00001', 2)
    f.add('T-00002.child', 8, 3)
    f.add('T-00003', 3, 9)
    f.add('T-00004', 4, 4)
    const plan = await planBackfill(f.client, 'scratch')
    expect(plan.scanned).toBe(4)
    expect(plan.pages).toBe(2)
    expect(plan.rows.map((r) => [r.targetRev, r.write])).toEqual([
      [2, true],
      [8, true],
      [9, false],
      [4, false],
    ])
    expect(f.calls).toEqual(['page:first', 'page:second'])
    expect(f.events.size).toBe(0)
    const result = await applyBackfill(f.client, plan, 'scratch', plan.sha256)
    expect([result.written, result.eventsCreated]).toEqual([2, 4])
    const again = await applyBackfill(f.client, plan, 'scratch', plan.sha256)
    expect([again.written, again.eventsCreated]).toEqual([0, 0])
    expect(f.events.size).toBe(4)
    expect(f.tasks.get('T-00002.child')?.etag).toBe(2)
  })
  for (const boundary of ['before-put', 'after-put', 'before-event', 'after-event'] as const) {
    test(`stop/resume same manifest after ${boundary}, then keyed zero/zero`, async () => {
      const f = fixture()
      f.add('T-00001', 2)
      const plan = await planBackfill(f.client, 'scratch')
      f.fail(boundary)
      await expect(applyBackfill(f.client, plan, 'scratch', plan.sha256)).rejects.toBeInstanceOf(
        BackfillFailure
      )
      await applyBackfill(f.client, plan, 'scratch', plan.sha256)
      const result = await applyBackfill(f.client, plan, 'scratch', plan.sha256)
      expect([result.written, result.eventsCreated]).toEqual([0, 0])
      expect(f.exts.get('T-00001')?.etag).toBe(1)
      expect(f.events.size).toBe(1)
      expect([...f.events.values()][0]).toMatchObject({
        attributes: { meta_rev: '2', ext_rev: 'null', written: 'true' },
      })
    })
  }
  test('retained operator shapes are nonrequests; malformed actual requests still refuse', async () => {
    // Exact nonrequest bodies from T-12366/operator-census/diagnostic-full.
    const shapes = [
      ['T-01144', { acp: { fromKind: 'bug', kind: 'bug', promoted: true } }],
      ['T-2331290C', { acp: { kind: 'task' } }],
      ['T-2417717B', { acp: { kind: 'task' } }],
      ['T-3E77507D', { acp: { kind: 'code_change' } }],
    ] as const
    const f = fixture()
    for (const [id, meta] of shapes) {
      f.add(id, 1)
      f.tasks.get(id)!.meta = structuredClone(meta)
    }
    f.add('T-09980.recon-smoke', 1)
    const plan = await planBackfill(f.client, 'scratch')
    expect(plan.scanned).toBe(5)
    expect(plan.rows.map((row) => row.task)).toEqual(['T-09980.recon-smoke'])
    expect(f.calls.every((call) => call.startsWith('page:'))).toBe(true)
    expect(f.events.size).toBe(0)
    for (const request of [null, {}, { rev: 0 }, { rev: 1, extra: true }, 'invalid']) {
      f.tasks.get('T-01144')!.meta = { acp: { request } }
      await expect(planBackfill(f.client, 'scratch')).rejects.toThrow()
    }
  })
  test('all-row preflight prevents partial writes on later task/extension drift', async () => {
    for (const drift of ['task', 'ext']) {
      const f = fixture()
      f.add('T-00001', 2)
      f.add('T-00002', 3, 1)
      const plan = await planBackfill(f.client, 'scratch')
      if (drift === 'task') f.tasks.get('T-00002')!.etag++
      else f.exts.set('T-00002', { body: { rev: 5 }, etag: 4 })
      await expect(applyBackfill(f.client, plan, 'scratch', plan.sha256)).rejects.toThrow(
        'backfill stopped'
      )
      expect(f.exts.has('T-00001')).toBe(false)
      expect(f.events.size).toBe(0)
    }
  })
  test('strict body validation and non-not-found errors fail closed', async () => {
    for (const body of [{ rev: 0 }, { rev: 2, extra: true }, { rev: 1.1 }]) {
      const f = fixture()
      f.add('T-00001', 2)
      f.exts.set('T-00001', { body, etag: 1 })
      await expect(planBackfill(f.client, 'scratch')).rejects.toThrow()
      f.exts.clear()
      f.tasks.get('T-00001')!.meta = { acp: { request: body } }
      await expect(planBackfill(f.client, 'scratch')).rejects.toThrow()
    }
    const f = fixture()
    f.add('T-00001', 1)
    f.fail('read')
    await expect(planBackfill(f.client, 'scratch')).rejects.toThrow('owner unreachable')
  })
  test('review digest and explicit target prevent plan tampering/route drift', async () => {
    const f = fixture()
    f.add('T-00001', 2)
    const plan = await planBackfill(f.client, 'scratch')
    expect(() => validateManifest(plan, 'live', plan.sha256)).toThrow('mismatch')
    expect(() =>
      validateManifest({ ...plan, principal: 'agent:faber' }, 'scratch', plan.sha256)
    ).toThrow('mismatch')
    plan.rows[0]!.targetRev = 99
    expect(() => validateManifest(plan, 'scratch', plan.sha256)).toThrow('mismatch')
  })
  test('apply never discovers or writes subjects added after review', async () => {
    const f = fixture()
    f.add('T-00001', 2)
    const plan = await planBackfill(f.client, 'scratch')
    f.add('T-00002', 10)
    await applyBackfill(f.client, plan, 'scratch', plan.sha256)
    expect(f.exts.has('T-00002')).toBe(false)
  })
  test('CLI rejects unfenced apply and principal override before transport', async () => {
    await expect(main(['--db', 'scratch', '--apply'])).rejects.toThrow('requires')
    await expect(main(['--db', 'scratch', '--as', 'agent:faber'])).rejects.toThrow(
      'invalid argument'
    )
  })
})
