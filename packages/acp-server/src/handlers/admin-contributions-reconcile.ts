import type { HrcActiveRunContributionResponse } from 'hrc-core'

import { badRequest, json, notFound, unprocessable } from '../http.js'
import { isRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'

type ReconcileBody = {
  inputApplicationId?: string | undefined
  allPending?: boolean | undefined
}

type ReconcileResult = {
  inputApplicationId: string
  inputAttemptId: string
  previousStatus: string
  status: 'accepted' | 'failed' | 'pending'
  hrcStatus?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

function parseBody(body: unknown): ReconcileBody {
  if (!isRecord(body)) {
    badRequest('request body must be a JSON object')
  }

  const inputApplicationId = body['inputApplicationId']
  const allPending = body['allPending']

  if (inputApplicationId !== undefined && typeof inputApplicationId !== 'string') {
    badRequest('inputApplicationId must be a string', { field: 'inputApplicationId' })
  }
  if (allPending !== undefined && typeof allPending !== 'boolean') {
    badRequest('allPending must be a boolean', { field: 'allPending' })
  }

  const trimmedInputApplicationId =
    typeof inputApplicationId === 'string' && inputApplicationId.trim().length > 0
      ? inputApplicationId.trim()
      : undefined

  if (trimmedInputApplicationId !== undefined && allPending === true) {
    badRequest('provide either inputApplicationId or allPending, not both')
  }
  if (trimmedInputApplicationId === undefined && allPending !== true) {
    badRequest('inputApplicationId or allPending is required')
  }

  return {
    ...(trimmedInputApplicationId !== undefined
      ? { inputApplicationId: trimmedInputApplicationId }
      : {}),
    ...(allPending === true ? { allPending: true } : {}),
  }
}

function hrcErrorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } }
  if (typeof candidate?.status === 'number') {
    return candidate.status
  }
  if (typeof candidate?.response?.status === 'number') {
    return candidate.response.status
  }
  return undefined
}

function resultStatus(status: string): ReconcileResult['status'] {
  if (status === 'accepted' || status === 'applied') {
    return 'accepted'
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'failed'
  }
  return 'pending'
}

function summarize(results: readonly ReconcileResult[]): {
  accepted: number
  failed: number
  pending: number
} {
  return {
    accepted: results.filter((result) => result.status === 'accepted').length,
    failed: results.filter((result) => result.status === 'failed').length,
    pending: results.filter((result) => result.status === 'pending').length,
  }
}

export const handleReconcileAdminContributions: RouteHandler = async ({ request, deps }) => {
  const body = parseBody(await request.json())

  const applications =
    body.allPending === true
      ? deps.inputApplicationStore.listPending()
      : (() => {
          const application = deps.inputApplicationStore.getById(body.inputApplicationId ?? '')
          if (application === undefined) {
            notFound('input application not found', { inputApplicationId: body.inputApplicationId })
          }
          return [application]
        })()

  const hrcClient = deps.hrcClient
  const results: ReconcileResult[] = []
  for (const application of applications) {
    const previousStatus = application.status
    if (application.status !== 'pending') {
      results.push({
        inputApplicationId: application.inputApplicationId,
        inputAttemptId: application.inputAttemptId,
        previousStatus,
        status: resultStatus(application.status),
        ...(application.lastErrorCode !== undefined
          ? { errorCode: application.lastErrorCode }
          : {}),
        ...(application.lastErrorMessage !== undefined
          ? { errorMessage: application.lastErrorMessage }
          : {}),
      })
      continue
    }

    if (hrcClient === undefined) {
      unprocessable('hrc_client_not_configured', 'HRC client is not configured')
    }

    let ledger: HrcActiveRunContributionResponse
    try {
      ledger = await hrcClient.getActiveRunContribution(application.inputApplicationId)
    } catch (error) {
      if (hrcErrorStatus(error) !== 404) {
        throw error
      }
      ledger = {
        status: 'rejected',
        inputApplicationId: application.inputApplicationId,
        errorCode: 'hrc_ledger_missing',
        errorMessage: 'HRC contribution ledger row is missing',
      }
    }

    const reconciled = deps.inputApplicationStore.reconcileFromHrcLedger({
      inputApplicationId: application.inputApplicationId,
      inputAdmissionStore: deps.inputAdmissionStore,
      ledger,
    })

    results.push({
      inputApplicationId: reconciled.inputApplication.inputApplicationId,
      inputAttemptId: reconciled.inputApplication.inputAttemptId,
      previousStatus,
      status: resultStatus(reconciled.inputApplication.status),
      hrcStatus: ledger.status,
      ...(reconciled.inputApplication.lastErrorCode !== undefined
        ? { errorCode: reconciled.inputApplication.lastErrorCode }
        : {}),
      ...(reconciled.inputApplication.lastErrorMessage !== undefined
        ? { errorMessage: reconciled.inputApplication.lastErrorMessage }
        : {}),
    })
  }

  return json({ results, summary: summarize(results) })
}
