import { describe, expect, test } from 'bun:test'

import {
  type LaunchCall,
  admissionRuntime,
  createAdmissionStores,
} from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input active-run contribution', () => {
  test('explicit active-run contribution queues fallback quietly when HRC recommends queue', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []
    const contributionCalls: unknown[] = []
    const consoleErrors: string[] = []
    const originalConsoleError = console.error
    console.error = ((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '))
    }) as typeof console.error

    try {
      await withWiredServer(
        async (fixture) => {
          const sessionRef = {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-contrib:role:implementer`,
            laneRef: 'main',
          }

          const first = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'contrib-first',
              sessionRef,
              content: 'start active run',
            },
          })
          const firstPayload = await fixture.json<{
            run: { runId: string; status: string }
          }>(first)
          expect(firstPayload.run.status).toBe('running')

          const contributionBody = {
            idempotencyKey: 'contrib-second',
            sessionRef,
            content: 'append this if supported',
            intent: {
              kind: 'contribute_to_active_run',
              fallback: 'queue',
              contributionSemantics: 'append_context',
            },
          }
          const contribution = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: contributionBody,
          })
          const replay = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: contributionBody,
          })
          const payload = await fixture.json<{
            run: { runId: string; status: string }
            inputApplication: {
              inputApplicationId: string
              status: string
              targetRunId: string
            }
            admission: {
              kind: string
              runId: string
              queueItemId: string
              inputApplicationId: string
            }
            currentState: {
              queueStatus: string
              applicationStatus: string
              reason: string
            }
          }>(contribution)
          const replayPayload = await fixture.json<{ admission: unknown }>(replay)

          expect(contribution.status).toBe(201)
          expect(replay.status).toBe(200)
          expect(payload.admission.kind).toBe('queued_run')
          expect(payload.admission.inputApplicationId).toBe(
            payload.inputApplication.inputApplicationId
          )
          expect(payload.inputApplication.status).toBe('failed')
          expect(payload.inputApplication.targetRunId).toBe(firstPayload.run.runId)
          expect(payload.currentState).toEqual(
            expect.objectContaining({
              queueStatus: 'queued',
              applicationStatus: 'failed',
              reason: 'feature_disabled',
            })
          )
          expect(payload.run.status).toBe('queued')
          expect(stores.inputQueueStore.getById(payload.admission.queueItemId)?.resetPolicy).toBe(
            'expire_on_generation_change'
          )
          expect(replayPayload.admission).toEqual(payload.admission)
          expect(contributionCalls).toHaveLength(1)
          expect(contributionCalls[0]).toEqual(
            expect.objectContaining({
              inputApplicationId: payload.inputApplication.inputApplicationId,
              expectedRunId: 'hrc-active',
              prompt: 'append this if supported',
            })
          )
          expect(launchCalls).toHaveLength(1)
          expect(
            stores.adminStore.systemEvents
              .list({ projectId: fixture.seed.projectId })
              .map((event) => event.kind)
          ).toContain('input.queued')
          expect(consoleErrors).toEqual([])
        },
        {
          ...stores,
          runtimeResolver: async () => admissionRuntime(),
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, {
                status: 'running',
                hrcRunId: 'hrc-active',
                hostSessionId: 'hsid-active',
                generation: 3,
                runtimeId: 'rt-active',
              })
            }
            return { runId: 'hrc-active', sessionId: 'hsid-active' }
          },
          hrcClient: {
            submitActiveRunContribution: async (request: unknown) => {
              contributionCalls.push(request)
              const inputApplicationId = (request as { inputApplicationId: string })
                .inputApplicationId
              return {
                status: 'queue_recommended',
                inputApplicationId,
                hostSessionId: 'hsid-active',
                generation: 3,
                runtimeId: 'rt-active',
                runId: 'hrc-active',
                capability: { supported: false, reason: 'feature_disabled' },
              }
            },
          } as never,
        }
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  test('accepted active-run contribution does not consume ordinary busy FIFO sequence', async () => {
    const stores = createAdmissionStores()
    const contributionCalls: unknown[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-mixed-fifo:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-active',
            sessionRef,
            content: 'start active run',
          },
        })

        const ordinaryOne = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-1',
            sessionRef,
            content: 'ordinary one',
          },
        })
        const ordinaryTwo = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-2',
            sessionRef,
            content: 'ordinary two',
          },
        })
        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-contribution',
            sessionRef,
            content: 'contribution follows active run',
            intent: { kind: 'contribute_to_active_run', fallback: 'reject' },
          },
        })
        const ordinaryThree = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-3',
            sessionRef,
            content: 'ordinary three',
          },
        })

        const ordinaryOnePayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryOne)
        const ordinaryTwoPayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryTwo)
        const contributionPayload = await fixture.json<{
          inputApplication: { inputApplicationId: string; status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; seq?: number | undefined }
        }>(contribution)
        const ordinaryThreePayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryThree)

        expect(ordinaryOnePayload.admission.kind).toBe('queued_run')
        expect(ordinaryTwoPayload.admission.kind).toBe('queued_run')
        expect(contributionPayload.admission.kind).toBe('accepted_in_flight')
        expect(contributionPayload.currentState).toEqual(
          expect.objectContaining({ applicationStatus: 'accepted' })
        )
        expect(contributionPayload.currentState.seq).toBeUndefined()
        expect(ordinaryThreePayload.admission.kind).toBe('queued_run')
        expect([
          ordinaryOnePayload.currentState.seq,
          ordinaryTwoPayload.currentState.seq,
          ordinaryThreePayload.currentState.seq,
        ]).toEqual([
          ordinaryOnePayload.currentState.seq,
          ordinaryOnePayload.currentState.seq + 1,
          ordinaryOnePayload.currentState.seq + 2,
        ])
        expect(
          stores.inputQueueStore
            .listForSession(sessionRef.scopeRef, sessionRef.laneRef)
            .map((item) => item.seq)
        ).toEqual([
          ordinaryOnePayload.currentState.seq,
          ordinaryTwoPayload.currentState.seq,
          ordinaryThreePayload.currentState.seq,
        ])
        expect(contributionCalls).toHaveLength(1)
      },
      {
        ...stores,
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-mixed-fifo',
              hostSessionId: 'hsid-mixed-fifo',
              generation: 5,
              runtimeId: 'rt-mixed-fifo',
            })
          }
          return { runId: 'hrc-mixed-fifo', sessionId: 'hsid-mixed-fifo' }
        },
        hrcClient: {
          submitActiveRunContribution: async (request: unknown) => {
            contributionCalls.push(request)
            const inputApplicationId = (request as { inputApplicationId: string })
              .inputApplicationId
            return {
              status: 'accepted',
              inputApplicationId,
              hostSessionId: 'hsid-mixed-fifo',
              generation: 5,
              runtimeId: 'rt-mixed-fifo',
              runId: 'hrc-mixed-fifo',
              capability: {
                supported: true,
                deliverySemantics: 'sequential_followup',
                ackSemantics: 'accepted_only',
                ordering: 'fifo',
                supportsAttachments: false,
              },
            }
          },
        } as never,
      }
    )
  })

  test('legacy federated transport no longer writes an HRC semantic message', async () => {
    const stores = createAdmissionStores()
    const contributionCalls: unknown[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:clod:project:${fixture.seed.projectId}:task:T-federated-ask`,
          laneRef: 'main',
        }
        const active = fixture.runStore.createRun({
          sessionRef,
          actor: { kind: 'human', id: 'discord-user' },
          status: 'running',
          metadata: {
            meta: {
              hrcSemanticMessage: {
                requestMessageId: 'msg-original-request',
                rootMessageId: 'msg-original-request',
                homeNodeId: 'lab',
              },
            },
          },
        })
        fixture.runStore.updateRun(active.runId, {
          transport: 'federated-message',
        })

        const body = {
          idempotencyKey: 'federated-ask-apple',
          sessionRef,
          content: 'Apple',
          actor: { kind: 'human', id: 'discord-user' },
          intent: {
            kind: 'contribute_to_active_run',
            fallback: 'reject',
            contributionSemantics: 'interrupt_and_continue',
          },
        }
        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body,
        })
        const replay = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body,
        })
        const payload = await fixture.json<{
          admission: { kind: string; runId: string }
          inputApplication: { status: string; targetRunId: string }
        }>(first)
        const replayPayload = await fixture.json<{ admission: unknown }>(replay)

        expect(first.status).toBe(201)
        expect(replay.status).toBe(200)
        expect(payload.admission.kind).toBe('accepted_in_flight')
        expect(payload.admission.runId).toBeUndefined()
        expect(payload.inputApplication).toMatchObject({
          status: 'accepted',
          targetRunId: active.runId,
        })
        expect(replayPayload.admission).toEqual(payload.admission)
        expect(contributionCalls).toHaveLength(1)
      },
      {
        ...stores,
        hrcClient: {
          submitActiveRunContribution: async (request: unknown) => {
            contributionCalls.push(request)
            return {
              status: 'accepted',
              inputApplicationId: 'iap-federated-legacy',
              hostSessionId: 'hsid-federated-legacy',
              generation: 1,
              runtimeId: 'rt-federated-legacy',
              runId: 'hrc-federated-legacy',
              capability: {
                supported: true,
                deliverySemantics: 'sequential_followup',
                ackSemantics: 'accepted_only',
                ordering: 'fifo',
                supportsAttachments: false,
              },
            }
          },
        } as never,
      }
    )
  })

  test('ambiguous active-run contribution remains admission_pending and does not queue', async () => {
    const stores = createAdmissionStores()

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-ambiguous:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ambiguous-first',
            sessionRef,
            content: 'start active run',
          },
        })

        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ambiguous-second',
            sessionRef,
            content: 'maybe delivered',
            intent: { kind: 'contribute_to_active_run', fallback: 'queue' },
          },
        })
        const payload = await fixture.json<{
          targetRun: { runId: string; status: string }
          inputApplication: { status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(contribution)

        expect(contribution.status).toBe(201)
        expect(payload.admission.kind).toBe('admission_pending')
        expect(payload.inputApplication.status).toBe('ambiguous')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'ambiguous',
            reason: 'delivery_ambiguous',
          })
        )
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toContain('input.application.pending')
      },
      {
        ...stores,
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-ambiguous',
              hostSessionId: 'hsid-ambiguous',
            })
          }
          return { runId: 'hrc-ambiguous', sessionId: 'hsid-ambiguous' }
        },
        hrcClient: {
          submitActiveRunContribution: async () => {
            throw new Error('timeout waiting for active-run contribution')
          },
        } as never,
      }
    )
  })

  test('transport-error active-run contribution remains admission_pending and replays without queue fallback', async () => {
    const stores = createAdmissionStores()
    let contributionCalls = 0

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-transport-pending:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'transport-pending-first',
            sessionRef,
            content: 'start active run',
          },
        })

        const contributionBody = {
          idempotencyKey: 'transport-pending-second',
          sessionRef,
          content: 'recover this later',
          intent: {
            kind: 'contribute_to_active_run',
            fallback: 'pending_only',
          },
        }
        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: contributionBody,
        })
        const replay = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: contributionBody,
        })
        const payload = await fixture.json<{
          inputAttempt: { inputAttemptId: string }
          targetRun: { runId: string; status: string }
          inputApplication: { inputApplicationId: string; status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(contribution)
        const replayPayload = await fixture.json<{
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(replay)
        const attempt = await fixture.request({
          method: 'GET',
          path: `/v1/input-attempts/${payload.inputAttempt.inputAttemptId}`,
        })
        const attemptPayload = await fixture.json<{
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(attempt)

        expect(contribution.status).toBe(201)
        expect(replay.status).toBe(200)
        expect(attempt.status).toBe(200)
        expect(payload.admission.kind).toBe('admission_pending')
        expect(payload.inputApplication.status).toBe('pending')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'pending',
            reason: 'delivery_transport_error',
          })
        )
        expect(attemptPayload.admission).toEqual(payload.admission)
        expect(attemptPayload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'pending',
            reason: 'delivery_transport_error',
          })
        )
        expect(replayPayload.admission).toEqual(payload.admission)
        expect(replayPayload.currentState).toEqual(payload.currentState)
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(contributionCalls).toBe(1)
      },
      {
        ...stores,
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-transport-pending',
              hostSessionId: 'hsid-transport-pending',
              generation: 7,
              runtimeId: 'rt-transport-pending',
            })
          }
          return {
            runId: 'hrc-transport-pending',
            sessionId: 'hsid-transport-pending',
          }
        },
        hrcClient: {
          submitActiveRunContribution: async () => {
            contributionCalls += 1
            const error: Error & { code?: string } = new Error('HRC transport unavailable')
            error.code = 'transport_error'
            throw error
          },
        } as never,
      }
    )
  })
})
