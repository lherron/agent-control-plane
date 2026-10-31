import type { WorkClient } from '@wrkq/client'

import { AcpHttpError, json, notFound } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

/**
 * T-12177: cancel one ledger-routed interface input.
 *
 * A Discord message routed through the collaboration ledger never gets an ACP
 * run, so `/v1/runs/:id/cancel` cannot address it. The envelope ingress sent
 * is the handle instead: unpresented, it is withdrawn; presented, its receipt
 * names the HRC turn ({node, runtimeId, inputId}) and that turn is interrupted
 * on its own node, only while its broker turn manifest still carries the input. The obligation is acked first, so the interrupted turn is
 * not re-driven by its still-open mail.
 *
 * Acts as the principal ingress recorded on the ledger route for this
 * (gateway, room), and adds no authorization rule of its own: who may cancel
 * is decided by the gateway, exactly as for ACP-run cancel.
 */

export type LedgerInputCancelOutcome =
  | { outcome: 'withdrawn' }
  | { outcome: 'interrupted'; node?: string | undefined; runtimeId: string }
  | {
      outcome: 'not_applied'
      reason: string
      node?: string | undefined
      runtimeId?: string | undefined
    }

type EnvelopeView = Awaited<ReturnType<WorkClient['wrkq']['envelope']['show']>>

const WITHDRAW_REASON = 'cancelled from Discord'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function latestReceipt(envelope: EnvelopeView) {
  const recipient = envelope.to?.scopeRef ?? envelope.to?.principalRef
  const receipts = envelope.presentedTo ?? []
  const forRecipient = receipts.filter(
    (receipt) => recipient === undefined || receipt.memberRef === recipient
  )
  return (forRecipient.length > 0 ? forRecipient : receipts).at(-1)
}

export const handleCancelLedgerInput: RouteHandler = async ({ params, request, deps }) => {
  const envelopeId = params['envelopeId']
  if (envelopeId === undefined || !/^EN-\d+$/.test(envelopeId)) {
    throw new AcpHttpError(400, 'malformed_request', 'envelopeId must be an EN-<n> envelope id')
  }
  const body = requireRecord(await parseJsonBody(request))
  const gatewayId = requireTrimmedStringField(body, 'gatewayId')
  const roomUuid = requireTrimmedStringField(body, 'roomUuid')
  const actorRef =
    typeof body['actorRef'] === 'string' && body['actorRef'].trim().length > 0
      ? body['actorRef'].trim()
      : 'discord'

  const route = deps.interfaceStore.discordLedgerProjection.getRoute(gatewayId, roomUuid)
  if (route === undefined) {
    notFound(`no ledger route for ${gatewayId} room ${roomUuid}`, {
      code: 'ledger_route_not_found',
      gatewayId,
      roomUuid,
    })
  }
  if (deps.workClientForPrincipal === undefined) {
    return json({
      outcome: 'not_applied',
      reason: 'ledger_unavailable',
    } satisfies LedgerInputCancelOutcome)
  }

  const client = await deps.workClientForPrincipal(route.humanPrincipalRef)
  const envelope = client.wrkq.envelope
  const show = () => envelope.show({ envelope: envelopeId, principalRef: route.humanPrincipalRef })

  let view = await show()
  if (!view.terminal && (view.state === 'pending' || view.state === 'deferred')) {
    const result = await envelope.withdraw({
      envelope: envelopeId,
      reason: WITHDRAW_REASON,
      principalRef: route.humanPrincipalRef,
    })
    if (result.withdrawn.some((item) => item.id === envelopeId)) {
      return json({ outcome: 'withdrawn' } satisfies LedgerInputCancelOutcome)
    }
    // Lost the race to presentation: the turn now owns it.
    view = await show()
  }

  if (view.terminal || view.state !== 'presented') {
    return json({
      outcome: 'not_applied',
      reason: 'already_finished',
    } satisfies LedgerInputCancelOutcome)
  }

  const receipt = latestReceipt(view)
  const runtimeId = receipt?.runtimeId
  if (receipt === undefined || runtimeId === undefined) {
    return json({
      outcome: 'not_applied',
      reason: 'no_runtime_on_receipt',
    } satisfies LedgerInputCancelOutcome)
  }
  const target = { ...(receipt.node !== undefined ? { node: receipt.node } : {}), runtimeId }
  const inputId = receipt.inputId
  if (inputId === undefined) {
    // A launch-carried receipt names no input, so HRC could not guard the
    // interrupt to this input's turn; never send an unguarded one.
    return json({
      outcome: 'not_applied',
      reason: 'no_input_on_receipt',
      ...target,
    } satisfies LedgerInputCancelOutcome)
  }

  if (deps.hrcClient === undefined) {
    return json({
      outcome: 'not_applied',
      reason: 'hrc_unavailable',
      ...target,
    } satisfies LedgerInputCancelOutcome)
  }

  try {
    await envelope.ack({
      envelopes: [envelopeId],
      note: `cancelled from Discord by ${actorRef}`,
      principalRef: route.humanPrincipalRef,
    })
  } catch (error) {
    return json({
      outcome: 'not_applied',
      reason: `ack_failed: ${errorText(error)}`,
      ...target,
    } satisfies LedgerInputCancelOutcome)
  }

  try {
    const response = await deps.hrcClient.interrupt(runtimeId, {
      ...(receipt.node !== undefined ? { node: receipt.node } : {}),
      inputId,
    })
    if (typeof response.warning === 'string' && response.warning.length > 0) {
      return json({
        outcome: 'not_applied',
        reason: `turn_already_finished: ${response.warning}`,
        ...target,
      } satisfies LedgerInputCancelOutcome)
    }
  } catch (error) {
    return json({
      outcome: 'not_applied',
      reason: errorText(error),
      ...target,
    } satisfies LedgerInputCancelOutcome)
  }

  return json({ outcome: 'interrupted', ...target } satisfies LedgerInputCancelOutcome)
}
