import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import type { InputAdmissionRecord, InputApplication } from 'acp-core'
import type { HrcActiveRunContributionResponse } from 'hrc-core'

import {
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  type InputAdmissionStore,
  type InputApplicationStore,
} from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type ReconcileResult = {
  inputApplicationId: string
  inputAttemptId: string
  previousStatus: string
  status: 'accepted' | 'failed' | 'pending'
  hrcStatus?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

type ReconcileResponse = {
  results: ReconcileResult[]
  summary: {
    accepted: number
    failed: number
    pending: number
  }
}

type ReconcileStores = {
  adminStore: ReturnType<typeof createInMemoryAdminStore>
  inputAdmissionStore: InMemoryInputAdmissionStore
  inputApplicationStore: InMemoryInputApplicationStore
}

type ReconcileStoreContract = InputApplicationStore & {
  reconcileFromHrcLedger(input: {
    inputApplicationId: string
    ledger: HrcActiveRunContributionResponse
    inputAdmissionStore: InputAdmissionStore
  }): {
    inputApplication: InputApplication
    inputAdmission?: InputAdmissionRecord | undefined
  }
}

function createReconcileStores(): ReconcileStores {
  return {
    adminStore: createInMemoryAdminStore(),
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputApplicationStore: new InMemoryInputApplicationStore(),
  }
}

function seedPendingAdmission(
  stores: ReconcileStores,
  input: {
    inputAttemptId: string
    targetRunId: string
    status?: 'pending' | 'accepted' | 'failed' | 'ambiguous' | undefined
  }
): InputApplication {
  const application = stores.inputApplicationStore.create({
    inputAttemptId: input.inputAttemptId,
    targetRunId: input.targetRunId,
    hrcRunId: input.targetRunId,
    hostSessionId: `hsid-${input.inputAttemptId}`,
    generation: 3,
    runtimeId: `rt-${input.inputAttemptId}`,
    status: input.status ?? 'pending',
  })

  stores.inputAdmissionStore.create({
    inputAttemptId: input.inputAttemptId,
    admissionKind: input.status === 'accepted' ? 'accepted_in_flight' : 'admission_pending',
    intent: { kind: 'contribute_to_active_run', fallback: 'pending_only' },
    originalResponse: {
      kind: input.status === 'accepted' ? 'accepted_in_flight' : 'admission_pending',
      inputApplicationId: application.inputApplicationId,
      runId: input.targetRunId,
    },
    currentState: {
      applicationStatus: input.status ?? 'pending',
      reason: 'delivery_transport_error',
    },
    inputApplicationId: application.inputApplicationId,
    runId: input.targetRunId,
    status: input.status === 'accepted' ? 'accepted' : 'admission_pending',
  })

  return application
}

function hrcNotFound(): Error & { status?: number } {
  const error: Error & { status?: number } = new Error('HRC request failed with status 404')
  error.status = 404
  return error
}

describe('contribution reconciliation', () => {
  test('store reconciliation accepts an admission_pending application without mutating original admission response', () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-store-accepted',
      targetRunId: 'hrc-store-accepted',
    })
    const originalAdmission = stores.inputAdmissionStore.getByInputAttemptId(
      application.inputAttemptId
    )

    const reconciled = (
      stores.inputApplicationStore as ReconcileStoreContract
    ).reconcileFromHrcLedger({
      inputApplicationId: application.inputApplicationId,
      inputAdmissionStore: stores.inputAdmissionStore,
      ledger: {
        status: 'accepted',
        inputApplicationId: application.inputApplicationId,
        runId: 'hrc-store-accepted',
        hostSessionId: 'hsid-store-accepted',
        generation: 4,
        runtimeId: 'rt-store-accepted',
      },
    })

    expect(reconciled.inputApplication).toMatchObject({
      inputApplicationId: application.inputApplicationId,
      status: 'accepted',
      hrcRunId: 'hrc-store-accepted',
      hostSessionId: 'hsid-store-accepted',
      generation: 4,
      runtimeId: 'rt-store-accepted',
    })
    expect(reconciled.inputAdmission).toMatchObject({
      inputAttemptId: application.inputAttemptId,
      admissionKind: 'accepted_in_flight',
      currentState: expect.objectContaining({ applicationStatus: 'accepted' }),
    })
    expect(reconciled.inputAdmission?.originalResponse).toEqual(originalAdmission?.originalResponse)
  })

  test('single id accepted from HRC transitions ACP InputApplication and InputAdmission', async () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-route-accepted',
      targetRunId: 'hrc-route-accepted',
    })
    const originalAdmission = stores.inputAdmissionStore.getByInputAttemptId(
      application.inputAttemptId
    )

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          headers: { 'x-acp-actor': 'agent:operator' },
          body: { inputApplicationId: application.inputApplicationId },
        })
        const payload = await fixture.json<ReconcileResponse>(response)

        expect(response.status).toBe(200)
        expect(payload).toEqual({
          results: [
            expect.objectContaining({
              inputApplicationId: application.inputApplicationId,
              inputAttemptId: application.inputAttemptId,
              previousStatus: 'pending',
              status: 'accepted',
              hrcStatus: 'accepted',
            }),
          ],
          summary: { accepted: 1, failed: 0, pending: 0 },
        })
        expect(stores.inputApplicationStore.getById(application.inputApplicationId)).toMatchObject({
          status: 'accepted',
          hrcRunId: 'hrc-route-accepted',
          hostSessionId: 'hsid-route-accepted',
          generation: 5,
          runtimeId: 'rt-route-accepted',
        })
        expect(
          stores.inputAdmissionStore.getByInputAttemptId(application.inputAttemptId)
        ).toMatchObject({
          admissionKind: 'accepted_in_flight',
          currentState: expect.objectContaining({ applicationStatus: 'accepted' }),
          originalResponse: originalAdmission?.originalResponse,
        })
      },
      {
        ...stores,
        hrcClient: {
          getActiveRunContribution: async () => ({
            status: 'accepted',
            inputApplicationId: application.inputApplicationId,
            runId: 'hrc-route-accepted',
            hostSessionId: 'hsid-route-accepted',
            generation: 5,
            runtimeId: 'rt-route-accepted',
          }),
        } as never,
      }
    )
  })

  test('single id rejected from HRC marks ACP application failed with ledger error details', async () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-route-rejected',
      targetRunId: 'hrc-route-rejected',
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          body: { inputApplicationId: application.inputApplicationId },
        })
        const payload = await fixture.json<ReconcileResponse>(response)

        expect(response.status).toBe(200)
        expect(payload.summary).toEqual({ accepted: 0, failed: 1, pending: 0 })
        expect(payload.results[0]).toMatchObject({
          inputApplicationId: application.inputApplicationId,
          previousStatus: 'pending',
          status: 'failed',
          hrcStatus: 'rejected',
          errorCode: 'provider_rejected_input',
          errorMessage: 'provider rejected input',
        })
        expect(stores.inputApplicationStore.getById(application.inputApplicationId)).toMatchObject({
          status: 'failed',
          lastErrorCode: 'provider_rejected_input',
          lastErrorMessage: 'provider rejected input',
        })
      },
      {
        ...stores,
        hrcClient: {
          getActiveRunContribution: async () => ({
            status: 'rejected',
            inputApplicationId: application.inputApplicationId,
            errorCode: 'provider_rejected_input',
            errorMessage: 'provider rejected input',
          }),
        } as never,
      }
    )
  })

  test('all-pending reconciliation consults only pending InputApplications', async () => {
    const stores = createReconcileStores()
    const pendingOne = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-all-one',
      targetRunId: 'hrc-all-one',
    })
    const alreadyAccepted = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-all-accepted',
      targetRunId: 'hrc-all-accepted',
      status: 'accepted',
    })
    const pendingTwo = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-all-two',
      targetRunId: 'hrc-all-two',
    })
    const consulted: string[] = []

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          body: { allPending: true },
        })
        const payload = await fixture.json<ReconcileResponse>(response)

        expect(response.status).toBe(200)
        expect(consulted.sort()).toEqual(
          [pendingOne.inputApplicationId, pendingTwo.inputApplicationId].sort()
        )
        expect(consulted).not.toContain(alreadyAccepted.inputApplicationId)
        expect(payload.summary).toEqual({ accepted: 1, failed: 0, pending: 1 })
      },
      {
        ...stores,
        hrcClient: {
          getActiveRunContribution: async (inputApplicationId: string) => {
            consulted.push(inputApplicationId)
            return {
              status:
                inputApplicationId === pendingOne.inputApplicationId ? 'duplicate' : 'pending',
              inputApplicationId,
            }
          },
        } as never,
      }
    )
  })

  test('HRC 404 marks the application failed with hrc_ledger_missing', async () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-route-missing',
      targetRunId: 'hrc-route-missing',
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          body: { inputApplicationId: application.inputApplicationId },
        })
        const payload = await fixture.json<ReconcileResponse>(response)

        expect(response.status).toBe(200)
        expect(payload.summary).toEqual({ accepted: 0, failed: 1, pending: 0 })
        expect(payload.results[0]).toMatchObject({
          status: 'failed',
          errorCode: 'hrc_ledger_missing',
        })
        expect(stores.inputApplicationStore.getById(application.inputApplicationId)).toMatchObject({
          status: 'failed',
          lastErrorCode: 'hrc_ledger_missing',
        })
      },
      {
        ...stores,
        hrcClient: {
          getActiveRunContribution: async () => {
            throw hrcNotFound()
          },
        } as never,
      }
    )
  })

  test('reconciliation is idempotent for an already accepted application', async () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-route-idempotent',
      targetRunId: 'hrc-route-idempotent',
    })
    let hrcLookups = 0

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          body: { inputApplicationId: application.inputApplicationId },
        })
        const second = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          body: { inputApplicationId: application.inputApplicationId },
        })
        const secondPayload = await fixture.json<ReconcileResponse>(second)

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(hrcLookups).toBe(1)
        expect(secondPayload.summary).toEqual({ accepted: 1, failed: 0, pending: 0 })
        expect(
          stores.inputAdmissionStore.getByInputAttemptId(application.inputAttemptId)
        ).toMatchObject({
          admissionKind: 'accepted_in_flight',
          currentState: expect.objectContaining({ applicationStatus: 'accepted' }),
        })
      },
      {
        ...stores,
        hrcClient: {
          getActiveRunContribution: async () => {
            hrcLookups += 1
            return {
              status: 'accepted',
              inputApplicationId: application.inputApplicationId,
              runId: 'hrc-route-idempotent',
            }
          },
        } as never,
      }
    )
  })

  test('reconciliation requires admin actor authorization', async () => {
    const stores = createReconcileStores()
    const application = seedPendingAdmission(stores, {
      inputAttemptId: 'attempt-route-authz',
      targetRunId: 'hrc-route-authz',
    })
    const authzCalls: unknown[] = []

    await withWiredServer(
      async (fixture) => {
        const denied = await fixture.request({
          method: 'POST',
          path: '/v1/admin/contributions/reconcile',
          headers: { 'x-acp-actor': 'agent:readonly' },
          body: { inputApplicationId: application.inputApplicationId },
        })

        expect(denied.status).toBe(403)
        expect(authzCalls).toEqual([
          [
            { kind: 'agent', id: 'readonly' },
            'admin.contributions.reconcile',
            { kind: 'input-application', id: application.inputApplicationId },
          ],
        ])
      },
      {
        ...stores,
        authorize: (...args) => {
          authzCalls.push(args)
          return 'deny'
        },
      }
    )
  })
})
