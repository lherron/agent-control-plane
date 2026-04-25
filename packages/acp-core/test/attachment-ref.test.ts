import { describe, expect, test } from 'bun:test'

import type { AttachmentRef, DeliveryRequestBody } from '../src/index.js'

describe('AttachmentRef', () => {
  test('preserves alt text through delivery body JSON serialization', () => {
    const attachment: AttachmentRef = {
      kind: 'file',
      path: '/tmp/acp/outbound/run-1/chart.png',
      filename: 'chart.png',
      contentType: 'image/png',
      sizeBytes: 128,
      alt: 'Generated chart preview',
    }
    const body: DeliveryRequestBody = {
      kind: 'text/markdown',
      text: 'Attached.',
      attachments: [attachment],
    }

    expect(JSON.parse(JSON.stringify(body))).toEqual({
      kind: 'text/markdown',
      text: 'Attached.',
      attachments: [
        {
          kind: 'file',
          path: '/tmp/acp/outbound/run-1/chart.png',
          filename: 'chart.png',
          contentType: 'image/png',
          sizeBytes: 128,
          alt: 'Generated chart preview',
        },
      ],
    })
  })
})
