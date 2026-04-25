import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInterfaceResponseCapture } from '../src/delivery/interface-response-capture.js'
import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

type UploadResponse = {
  outboundAttachmentId: string
  path: string
  filename: string
  contentType: string
  sizeBytes: number
  alt?: string
}

type ErrorResponse = {
  error: {
    code: string
    message: string
  }
}

const sessionRef = {
  scopeRef: 'agent:curly:project:agent-spaces',
  laneRef: 'main',
} as const

function createRunningRun(fixture: WiredServerFixture) {
  const run = fixture.runStore.createRun({ sessionRef })
  fixture.runStore.setDispatchFence(run.runId, {
    expectedHostSessionId: 'hsid-outbound',
    expectedGeneration: 3,
  })
  return fixture.runStore.updateRun(run.runId, {
    status: 'running',
    hrcRunId: 'hrc-run-outbound',
    hostSessionId: 'hsid-outbound',
    generation: 3,
  })
}

function createRunningInterfaceRun(fixture: WiredServerFixture) {
  const run = fixture.runStore.createRun({
    sessionRef,
    metadata: {
      meta: {
        interfaceSource: {
          gatewayId: 'discord_prod',
          bindingId: 'ifb_outbound',
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
        },
      },
    },
  })
  fixture.runStore.setDispatchFence(run.runId, {
    expectedHostSessionId: 'hsid-outbound',
    expectedGeneration: 3,
  })
  return fixture.runStore.updateRun(run.runId, {
    status: 'running',
    hrcRunId: 'hrc-run-outbound',
    hostSessionId: 'hsid-outbound',
    generation: 3,
  })
}

async function postAttachment(input: {
  fixture: WiredServerFixture
  runId: string
  file?: File | undefined
  alt?: string | undefined
  filename?: string | undefined
  contentType?: string | undefined
  headers?: HeadersInit | undefined
}): Promise<Response> {
  const form = new FormData()
  if (input.file !== undefined) {
    form.set('file', input.file)
  }
  if (input.alt !== undefined) {
    form.set('alt', input.alt)
  }
  if (input.filename !== undefined) {
    form.set('filename', input.filename)
  }
  if (input.contentType !== undefined) {
    form.set('contentType', input.contentType)
  }

  return input.fixture.handler(
    new Request(`http://acp.test/v1/runs/${input.runId}/outbound-attachments`, {
      method: 'POST',
      headers: input.headers,
      body: form,
    })
  )
}

function correlationHeaders(runId: string): HeadersInit {
  return {
    HRC_RUN_ID: runId,
    HRC_HOST_SESSION_ID: 'hsid-outbound',
    HRC_GENERATION: '3',
  }
}

describe('run outbound attachments', () => {
  test('POST accepts a small image, stores it on disk, and GET lists it', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-outbound-media-'))

    try {
      await withWiredServer(
        async (fixture) => {
          const run = createRunningRun(fixture)
          const response = await postAttachment({
            fixture,
            runId: run.runId,
            file: new File([new Uint8Array([1, 2, 3])], '../../bad image.png', {
              type: 'image/png',
            }),
            alt: 'A tiny generated image',
            headers: correlationHeaders(run.hrcRunId ?? run.runId),
          })
          const payload = await fixture.json<UploadResponse>(response)

          expect(response.status).toBe(201)
          expect(payload.outboundAttachmentId).toMatch(/^oa_/)
          expect(payload).toMatchObject({
            filename: 'bad_image.png',
            contentType: 'image/png',
            sizeBytes: 3,
            alt: 'A tiny generated image',
          })
          expect(payload.path).toContain(join(mediaStateDir, 'media', 'outbound', run.runId))
          expect(existsSync(payload.path)).toBe(true)

          const listResponse = await fixture.request({
            method: 'GET',
            path: `/v1/runs/${run.runId}/outbound-attachments`,
          })
          const listPayload = await fixture.json<{ attachments: UploadResponse[] }>(listResponse)

          expect(listResponse.status).toBe(200)
          expect(listPayload.attachments).toHaveLength(1)
          expect(listPayload.attachments[0]).toMatchObject({
            outboundAttachmentId: payload.outboundAttachmentId,
            filename: 'bad_image.png',
            contentType: 'image/png',
            sizeBytes: 3,
            alt: 'A tiny generated image',
          })
        },
        { mediaStateDir }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('POST attachment is captured onto the next gateway delivery body', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-outbound-media-'))

    try {
      await withWiredServer(
        async (fixture) => {
          const run = createRunningInterfaceRun(fixture)
          const uploadResponse = await postAttachment({
            fixture,
            runId: run.runId,
            file: new File([new Uint8Array([7, 8, 9])], 'delivery.png', {
              type: 'image/png',
            }),
            alt: 'Delivery image alt',
            headers: correlationHeaders(run.hrcRunId ?? run.runId),
          })

          expect(uploadResponse.status).toBe(201)

          const capture = createInterfaceResponseCapture({
            interfaceStore: fixture.interfaceStore,
            runStore: fixture.runStore,
            runId: run.runId,
          })
          await capture.handler({
            type: 'message_end',
            messageId: 'msg-delivery',
            message: { role: 'assistant', content: 'Here is the image.' },
          })

          const streamResponse = await fixture.request({
            method: 'GET',
            path: '/v1/gateway/discord_prod/deliveries/stream',
          })
          const streamPayload = await fixture.json<{
            deliveries: Array<{
              body: {
                text: string
                attachments?: Array<Record<string, unknown>>
              }
            }>
          }>(streamResponse)

          expect(streamResponse.status).toBe(200)
          expect(streamPayload.deliveries).toHaveLength(1)
          expect(streamPayload.deliveries[0]?.body.text).toBe('Here is the image.')
          expect(streamPayload.deliveries[0]?.body.attachments).toEqual([
            expect.objectContaining({
              kind: 'file',
              filename: 'delivery.png',
              contentType: 'image/png',
              sizeBytes: 3,
              alt: 'Delivery image alt',
            }),
          ])
        },
        { mediaStateDir }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('POST rejects unsupported content type with 400', async () => {
    await withWiredServer(async (fixture) => {
      const run = createRunningRun(fixture)
      const response = await postAttachment({
        fixture,
        runId: run.runId,
        file: new File(['<html></html>'], 'page.html', { type: 'text/html' }),
        headers: correlationHeaders(run.runId),
      })
      const payload = await fixture.json<ErrorResponse>(response)

      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('unsupported_content_type')
    })
  })

  test('POST rejects oversized files with 413', async () => {
    await withWiredServer(
      async (fixture) => {
        const run = createRunningRun(fixture)
        const response = await postAttachment({
          fixture,
          runId: run.runId,
          file: new File([new Uint8Array([1, 2, 3, 4, 5])], 'too-big.png', {
            type: 'image/png',
          }),
          headers: correlationHeaders(run.runId),
        })
        const payload = await fixture.json<ErrorResponse>(response)

        expect(response.status).toBe(413)
        expect(payload.error.code).toBe('attachment_too_large')
      },
      { attachmentMaxBytes: 4 }
    )
  })

  test('POST rejects unknown runs with 404', async () => {
    await withWiredServer(async (fixture) => {
      const response = await postAttachment({
        fixture,
        runId: 'run_missing',
        file: new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }),
        headers: correlationHeaders('run_missing'),
      })
      const payload = await fixture.json<ErrorResponse>(response)

      expect(response.status).toBe(404)
      expect(payload.error.code).toBe('run_not_found')
    })
  })

  test('POST rejects completed runs with 409', async () => {
    await withWiredServer(async (fixture) => {
      const run = createRunningRun(fixture)
      fixture.runStore.updateRun(run.runId, { status: 'completed' })

      const response = await postAttachment({
        fixture,
        runId: run.runId,
        file: new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }),
        headers: correlationHeaders(run.runId),
      })
      const payload = await fixture.json<ErrorResponse>(response)

      expect(response.status).toBe(409)
      expect(payload.error.code).toBe('run_not_accepting_outbound')
    })
  })

  test('POST rejects mismatched HRC_RUN_ID with correlation_mismatch', async () => {
    await withWiredServer(async (fixture) => {
      const run = createRunningRun(fixture)
      const response = await postAttachment({
        fixture,
        runId: run.runId,
        file: new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }),
        headers: correlationHeaders('hrc-run-other'),
      })
      const payload = await fixture.json<ErrorResponse>(response)

      expect(response.status).toBe(403)
      expect(payload.error.code).toBe('correlation_mismatch')
    })
  })

  test('POST rejects missing HRC_GENERATION when the run has a dispatch generation fence', async () => {
    await withWiredServer(async (fixture) => {
      const run = createRunningRun(fixture)
      const response = await postAttachment({
        fixture,
        runId: run.runId,
        file: new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }),
        headers: {
          HRC_RUN_ID: run.hrcRunId ?? run.runId,
          HRC_HOST_SESSION_ID: 'hsid-outbound',
        },
      })
      const payload = await fixture.json<ErrorResponse>(response)

      expect(response.status).toBe(403)
      expect(payload.error.code).toBe('correlation_mismatch')
    })
  })
})
