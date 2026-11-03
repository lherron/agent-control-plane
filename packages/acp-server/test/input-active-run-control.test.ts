import { describe, expect, test } from 'bun:test'

import { createAdmissionStores } from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input active-run control', () => {
  test('control intent interrupts the active runtime without creating queued work', async () => {
    const stores = createAdmissionStores()
    const interrupts: string[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-control:role:implementer`,
          laneRef: 'main',
        }

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'control-interrupt',
            sessionRef,
            content: 'interrupt',
            intent: { kind: 'control_active_run', action: 'interrupt' },
          },
        })
        const payload = await fixture.json<{
          admission: { kind: string }
          currentState: {
            controlStatus: string
            action: string
            runtimeId: string
          }
        }>(response)

        expect(response.status).toBe(201)
        expect(payload.admission.kind).toBe('accepted_in_flight')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            controlStatus: 'accepted',
            action: 'interrupt',
            runtimeId: 'rt-control',
          })
        )
        expect(interrupts).toEqual(['rt-control'])
        expect(fixture.runStore.listRuns()).toEqual([])
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toContain('input.application.accepted')
      },
      {
        ...stores,
        hrcClient: {
          resolveSession: async () => ({
            found: true,
            hostSessionId: 'hsid-control',
            generation: 4,
          }),
          listRuntimes: async () => [
            {
              runtimeId: 'rt-control',
              hostSessionId: 'hsid-control',
              generation: 4,
              status: 'ready',
              transport: 'tmux',
            },
          ],
          interrupt: async (runtimeId: string) => {
            interrupts.push(runtimeId)
            return { ok: true }
          },
        } as never,
      }
    )
  })
})
