import { describe, expect, mock, test } from 'bun:test'

import type { InterfaceStore } from 'acp-interface-store'

import { withWiredServer } from './fixtures/wired-server.js'

function seedBinding(
  store: InterfaceStore,
  overrides: Partial<Parameters<InterfaceStore['bindings']['create']>[0]> = {}
) {
  return store.bindings.create({
    bindingId: 'ifb_mneme',
    gatewayId: 'acp-discord-smoke',
    gatewayType: 'discord',
    conversationRef: 'channel:mneme',
    scopeRef: 'agent:mneme:project:media-ingest',
    laneRef: 'main',
    projectId: 'media-ingest',
    status: 'active',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  })
}

describe('POST /v1/agent-pulpit/messages', () => {
  test('binding mode enqueues a delivery and does not launch a run', async () => {
    const launchRoleScopedRun = mock(async () => {
      throw new Error('agent pulpit must not launch runs')
    })

    await withWiredServer(
      async (fixture) => {
        seedBinding(fixture.interfaceStore)

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/agent-pulpit/messages',
          headers: { 'x-acp-actor': 'agent:media-ingest' },
          body: {
            bindingId: 'ifb_mneme',
            gatewayType: 'discord',
            agentId: 'mneme',
            projectId: 'media-ingest',
            text: 'Transcription finished.',
            idempotencyKey: 'media-ingest:finished:1',
          },
        })
        const payload = await fixture.json<{
          delivery: { deliveryRequestId: string; status: string; runId?: string }
        }>(response)

        expect(response.status).toBe(201)
        expect(payload.delivery.deliveryRequestId).toMatch(/^dr_/)
        expect(payload.delivery.status).toBe('queued')
        expect(payload.delivery.runId).toBeUndefined()
        expect(launchRoleScopedRun).not.toHaveBeenCalled()
        expect(fixture.runStore.listRuns()).toHaveLength(0)

        expect(fixture.interfaceStore.deliveries.listQueuedForGateway('acp-discord-smoke')).toEqual(
          [
            expect.objectContaining({
              bindingId: 'ifb_mneme',
              gatewayId: 'acp-discord-smoke',
              scopeRef: 'agent:mneme:project:media-ingest',
              laneRef: 'main',
              conversationRef: 'channel:mneme',
              bodyKind: 'text/markdown',
              bodyText: 'Transcription finished.',
              actor: { kind: 'agent', id: 'media-ingest' },
            }),
          ]
        )
      },
      { launchRoleScopedRun }
    )
  })

  test('primary mode resolves one active discord project-level binding', async () => {
    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore)
      seedBinding(fixture.interfaceStore, {
        bindingId: 'ifb_task_specific',
        conversationRef: 'channel:task',
        scopeRef: 'agent:mneme:project:media-ingest:task:T-1',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
          text: 'Primary delivery.',
          idempotencyKey: 'media-ingest:finished:primary',
        },
      })
      const payload = await fixture.json<{ delivery: { bindingId: string } }>(response)

      expect(response.status).toBe(201)
      expect(payload.delivery.bindingId).toBe('ifb_mneme')
    })
  })

  test('rejects disabled, missing, mismatched, and ambiguous bindings', async () => {
    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore, { status: 'disabled' })

      const disabled = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          bindingId: 'ifb_mneme',
          text: 'Disabled.',
          idempotencyKey: 'disabled',
        },
      })
      expect(disabled.status).toBe(422)
      expect((await fixture.json<{ error: { code: string } }>(disabled)).error.code).toBe(
        'interface_binding_disabled'
      )
    })

    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore)
      const mismatch = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          bindingId: 'ifb_mneme',
          projectId: 'wrong-project',
          text: 'Mismatch.',
          idempotencyKey: 'mismatch',
        },
      })
      expect(mismatch.status).toBe(422)
      expect((await fixture.json<{ error: { code: string } }>(mismatch)).error.code).toBe(
        'interface_binding_mismatch'
      )
    })

    await withWiredServer(async (fixture) => {
      const missing = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
          text: 'Missing.',
          idempotencyKey: 'missing',
        },
      })
      expect(missing.status).toBe(404)
    })

    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore)
      seedBinding(fixture.interfaceStore, {
        bindingId: 'ifb_mneme_second',
        conversationRef: 'channel:mneme-2',
      })
      const ambiguous = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
          text: 'Ambiguous.',
          idempotencyKey: 'ambiguous',
        },
      })
      const payload = await fixture.json<{
        error: { code: string; details?: { candidates?: unknown[] } }
      }>(ambiguous)
      expect(ambiguous.status).toBe(409)
      expect(payload.error.code).toBe('interface_binding_ambiguous')
      expect(payload.error.details?.candidates).toHaveLength(2)
    })
  })

  test('idempotency replays current delivery status and conflicts on different fingerprints', async () => {
    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore)
      const body = {
        bindingId: 'ifb_mneme',
        text: 'Replay me.',
        idempotencyKey: 'same-key',
      }

      const first = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body,
      })
      const firstPayload = await fixture.json<{ delivery: { deliveryRequestId: string } }>(first)
      fixture.interfaceStore.deliveries.ack(
        firstPayload.delivery.deliveryRequestId,
        '2026-06-10T00:01:00.000Z'
      )

      const replay = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body,
      })
      const replayPayload = await fixture.json<{
        delivery: { deliveryRequestId: string; status: string; deliveredAt?: string }
      }>(replay)

      expect(first.status).toBe(201)
      expect(replay.status).toBe(200)
      expect(replayPayload.delivery.deliveryRequestId).toBe(firstPayload.delivery.deliveryRequestId)
      expect(replayPayload.delivery.status).toBe('delivered')
      expect(replayPayload.delivery.deliveredAt).toBe('2026-06-10T00:01:00.000Z')

      const conflict = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: { ...body, text: 'Different.' },
      })
      expect(conflict.status).toBe(409)
      expect((await fixture.json<{ error: { code: string } }>(conflict)).error.code).toBe(
        'idempotency_conflict'
      )
    })
  })

  test('requires idempotencyKey and does not require authz', async () => {
    await withWiredServer(async (fixture) => {
      seedBinding(fixture.interfaceStore)
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/agent-pulpit/messages',
        body: {
          bindingId: 'ifb_mneme',
          text: 'No key.',
        },
      })
      expect(response.status).toBe(400)
    })

    await withWiredServer(
      async (fixture) => {
        seedBinding(fixture.interfaceStore)
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/agent-pulpit/messages',
          headers: { 'x-acp-actor': 'agent:media-ingest' },
          body: {
            bindingId: 'ifb_mneme',
            text: 'No authz gate.',
            idempotencyKey: 'no-authz',
          },
        })
        expect(response.status).toBe(201)
        expect(fixture.interfaceStore.deliveries.listQueuedForGateway('acp-discord-smoke')).toEqual(
          [
            expect.objectContaining({
              bindingId: 'ifb_mneme',
              bodyText: 'No authz gate.',
              actor: { kind: 'agent', id: 'media-ingest' },
            }),
          ]
        )
      },
      { authorize: () => 'deny' }
    )
  })
})
