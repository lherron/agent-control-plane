import { describe, expect, test } from 'bun:test'
import { createClient } from '@wrkq/client'
import { FakeTransport } from '@wrkq/client/testing'
import { createWrkqReader } from '../src/ports.js'

function task(id: string, rev?: number) {
  return {
    id,
    state: 'open',
    projectUuid: 'project',
    priority: 2,
    createdAt: '2026-11-02T12:00:00Z',
    updatedAt: '2026-11-02T12:00:00Z',
    meta: rev === undefined ? {} : { acp: { request: { rev } } },
  }
}
function row(id: string) {
  return { id: 'main', subject: { type: 'task', id, state: 'open' } }
}
const missing = { code: -32004, message: 'not found', data: { code: 'WRKQ_NOT_FOUND' } }

describe('request discovery and read rule', () => {
  test('unions paginated ext and meta discovery, deduplicates, and uses ext rev', async () => {
    const transport = new FakeTransport()
      .onMethod('wrkq.ext.listView', (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: (req.params as { cursor?: string }).cursor
          ? { items: [row('T-3')] }
          : { items: [row('T-1')], nextCursor: 'ext-next' },
      }))
      .onMethod('wrkq.task.show', (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: (req.params as { task: string }).task === 'T-1' ? task('T-1') : task('T-3', 9),
      }))
      .onMethod('wrkq.task.list', (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: (req.params as { cursor?: string }).cursor
          ? { items: [task('T-3', 9), task('T-4')] }
          : { items: [task('T-2', 2)], nextCursor: 'meta-next' },
      }))
      .onMethod('wrkq.ext.show', (req) => {
        const id = (req.params as { subject: { task: string } }).subject.task
        return id === 'T-2'
          ? { jsonrpc: '2.0', id: req.id, error: missing }
          : { jsonrpc: '2.0', id: req.id, result: { ext: { body: { rev: id === 'T-1' ? 1 : 3 } } } }
      })
      .onResult('wrkq.container.show', { id: 'P-1', path: 'project', kind: 'project' })
    const client = await createClient({ transport, autoInitialize: false })
    const records = await createWrkqReader(client).listRequests()
    expect(records.map(({ id, marker }) => ({ id, marker }))).toEqual([
      { id: 'T-1', marker: { ok: true, rev: 1 } },
      { id: 'T-3', marker: { ok: true, rev: 3 } },
      { id: 'T-2', marker: { ok: true, rev: 2 } },
    ])
    const extCalls = transport.capturedRequests.filter((r) => r.method === 'wrkq.ext.listView')
    expect(extCalls.map((r) => r.params)).toEqual([
      {
        ns: 'acp',
        kind: 'request',
        subjectStates: ['idea', 'draft', 'open', 'in_progress', 'blocked'],
        limit: 500,
      },
      {
        ns: 'acp',
        kind: 'request',
        subjectStates: ['idea', 'draft', 'open', 'in_progress', 'blocked'],
        limit: 500,
        cursor: 'ext-next',
      },
    ])
    expect(
      transport.capturedRequests.filter((r) => r.method === 'wrkq.task.list')[1]?.params
    ).toMatchObject({ cursor: 'meta-next' })
    await client.close()
  })

  test('an invalid ext body overrides a valid meta marker', async () => {
    const transport = new FakeTransport()
      .onResult('wrkq.ext.listView', { items: [] })
      .onResult('wrkq.task.list', { items: [task('T-1', 4)] })
      .onResult('wrkq.ext.show', { ext: { body: { rev: 1, force: true } } })
      .onResult('wrkq.container.show', { id: 'P-1', path: 'project', kind: 'project' })
    const client = await createClient({ transport, autoInitialize: false })
    expect((await createWrkqReader(client).listRequests())[0]?.marker).toEqual({
      ok: false,
      reason: 'ext acp/request/main has unknown field(s): force',
    })
    await client.close()
  })

  test('ext read errors other than not_found fail the scan', async () => {
    const transport = new FakeTransport()
      .onResult('wrkq.ext.listView', { items: [] })
      .onResult('wrkq.task.list', { items: [task('T-1', 4)] })
      .onError('wrkq.ext.show', { code: -32603, message: 'unavailable' })
    const client = await createClient({ transport, autoInitialize: false })
    await expect(createWrkqReader(client).listRequests()).rejects.toThrow('unavailable')
    await client.close()
  })

  test('ignores non-singleton rows, other subjects, and tasks closed since discovery', async () => {
    const transport = new FakeTransport()
      .onResult('wrkq.ext.listView', {
        items: [
          { ...row('T-1'), id: 'other' },
          { id: 'main', subject: { type: 'container', id: 'P-1' } },
          row('T-2'),
        ],
      })
      .onResult('wrkq.task.show', { ...task('T-2'), state: 'completed' })
      .onResult('wrkq.task.list', { items: [] })
    const client = await createClient({ transport, autoInitialize: false })
    expect(await createWrkqReader(client).listRequests()).toEqual([])
    await client.close()
  })
})
