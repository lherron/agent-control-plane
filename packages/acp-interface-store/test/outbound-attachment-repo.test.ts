import { describe, expect, test } from 'bun:test'

import { withInterfaceStore } from './helpers.js'

describe('OutboundAttachmentRepo', () => {
  test('initializes the outbound_attachments table and index', () => {
    withInterfaceStore(({ store }) => {
      const columns = store.sqlite
        .prepare(`SELECT name FROM pragma_table_info('outbound_attachments') ORDER BY cid ASC`)
        .all() as Array<{ name: string }>
      const indexes = store.sqlite
        .prepare(`SELECT name FROM pragma_index_list('outbound_attachments') ORDER BY name ASC`)
        .all() as Array<{ name: string }>

      expect(columns.map((column) => column.name)).toEqual([
        'outboundAttachmentId',
        'runId',
        'state',
        'consumedByDeliveryRequestId',
        'path',
        'filename',
        'contentType',
        'sizeBytes',
        'alt',
        'createdAt',
        'updatedAt',
      ])
      expect(indexes.map((index) => index.name)).toContain('outbound_attachments_run_state_idx')
    })
  })

  test('creates and lists pending outbound attachments for a run', () => {
    withInterfaceStore(({ store }) => {
      const created = store.outboundAttachments.create({
        outboundAttachmentId: 'oa_test_1',
        runId: 'run-1',
        path: '/tmp/outbound/run-1/image.png',
        filename: 'image.png',
        contentType: 'image/png',
        sizeBytes: 9,
        alt: 'A generated chart',
        createdAt: '2026-04-25T04:00:00.000Z',
      })

      expect(created).toEqual({
        outboundAttachmentId: 'oa_test_1',
        runId: 'run-1',
        state: 'pending',
        path: '/tmp/outbound/run-1/image.png',
        filename: 'image.png',
        contentType: 'image/png',
        sizeBytes: 9,
        alt: 'A generated chart',
        createdAt: '2026-04-25T04:00:00.000Z',
        updatedAt: '2026-04-25T04:00:00.000Z',
      })
      expect(store.outboundAttachments.listForRun('run-1')).toEqual([created])
      expect(store.outboundAttachments.listForRun('run-2')).toEqual([])
    })
  })
})
