import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

const validWorkflow = {
  id: 'cli-published',
  version: 1,
  kind: 'generic',
  initial: { status: 'open', phase: 'todo' },
  phases: { todo: {}, done: {} },
  outcomes: { success: {} },
  roles: { collector: { binding: 'autoBindOnFirstRun' } },
  evidenceKinds: { completion_note: { requiredFields: ['summary'] } },
  transitions: {
    close_success: {
      id: 'close_success',
      from: { status: 'open', phase: 'todo' },
      to: { status: 'closed', outcome: 'success' },
      by: ['collector'],
    },
  },
}

describe('workflow publish route', () => {
  test('POST /v1/workflows publishes a valid workflow definition', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/workflows',
        body: validWorkflow,
      })
      const body = await fixture.json<{ definition: { id: string; version: number; hash: string } }>(
        response
      )

      expect(response.status).toBe(201)
      expect(body.definition).toMatchObject({
        id: 'cli-published',
        version: 1,
        workflow: { id: 'cli-published', version: 1 },
      })
      expect(body.definition.hash).toMatch(/^sha256:/)
    })
  })

  test('POST /v1/workflows rejects malformed JSON with 400', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.handler(
        new Request('http://acp.test/v1/workflows', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"id":',
        })
      )

      expect(response.status).toBe(400)
    })
  })

  test('POST /v1/workflows maps kernel validation errors to 422', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/workflows',
        body: {
          ...validWorkflow,
          id: 'invalid-initial',
          initial: { phase: 'todo' },
        },
      })
      const body = await fixture.json<{ error: { code: string; message: string } }>(response)

      expect(response.status).toBe(422)
      expect(body.error).toEqual({
        code: expect.any(String),
        message: expect.stringContaining('status'),
      })
    })
  })
})
