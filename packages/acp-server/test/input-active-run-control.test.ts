import { describe, expect, test } from 'bun:test'

import { createAdmissionStores } from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input active-run control', () => {
  test.each([
    ['cancel', 'ready', 'accepted_in_flight', undefined],
    ['pause', 'ready', 'rejected', 'control_action_not_supported'],
    ['interrupt', 'missing-client', 'rejected', 'hrc_client_not_configured'],
    ['interrupt', 'unresolved', 'rejected', 'runtime_not_found'],
    ['interrupt', 'empty', 'rejected', 'runtime_not_found'],
  ] as const)('%s with %s preserves admission and replay', async (action, mode, kind, reason) => {
    const stores = createAdmissionStores()
    const terminations: string[] = []
    await withWiredServer(
      async (fixture) => {
        const body = {
          sessionRef: {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'control',
          idempotencyKey: 'control-characterization',
          intent: { kind: 'control_active_run', action },
        }
        const first = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
        const replay = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
        const payload = await first.json()
        const replayPayload = await replay.json()
        expect(first.status).toBe(201)
        expect(replay.status).toBe(200)
        expect(payload.admission.kind).toBe(kind)
        expect(payload.currentState.reason).toBe(reason)
        expect(replayPayload.admission).toEqual(payload.admission)
        // Control replay recomputes state from run/application records, which controls do not create.
        expect(replayPayload.currentState).toEqual({})
        expect(terminations).toEqual(action === 'cancel' ? ['rt-latest'] : [])
        expect(fixture.runStore.listRuns()).toEqual([])
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toEqual([kind === 'rejected' ? 'input.rejected' : 'input.application.accepted'])
      },
      {
        ...stores,
        ...(mode === 'missing-client'
          ? {}
          : {
              hrcClient: {
                resolveSession: async () => ({
                  found: mode !== 'unresolved',
                  hostSessionId: 'hsid-control',
                }),
                listRuntimes: async () =>
                  mode === 'empty'
                    ? []
                    : [
                        { runtimeId: 'rt-old', hostSessionId: 'hsid-control' },
                        { runtimeId: 'rt-latest', hostSessionId: 'hsid-control' },
                      ],
                terminate: async (runtimeId: string) => {
                  terminations.push(runtimeId)
                },
              } as never,
            }),
      }
    )
  })

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
