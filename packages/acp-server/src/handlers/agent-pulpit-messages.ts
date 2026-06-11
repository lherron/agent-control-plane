import { createHash, randomUUID } from 'node:crypto'

import { parseActorFromHeaders } from 'acp-core'
import type { InterfaceBinding } from 'acp-interface-store'

import { AcpHttpError, json, unprocessable } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { toApiDeliveryRequest } from './interface-shared.js'

const ROUTE = 'POST /v1/agent-pulpit/messages'

function fingerprint(input: {
  binding: InterfaceBinding
  bodyKind: 'text/markdown'
  bodyText: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        gatewayId: input.binding.gatewayId,
        gatewayType: input.binding.gatewayType,
        bindingId: input.binding.bindingId,
        scopeRef: input.binding.scopeRef,
        laneRef: input.binding.laneRef,
        conversationRef: input.binding.conversationRef,
        threadRef: input.binding.threadRef ?? null,
        bodyKind: input.bodyKind,
        bodyText: input.bodyText,
      })
    )
    .digest('hex')
}

function candidateDetails(binding: InterfaceBinding): Record<string, unknown> {
  return {
    bindingId: binding.bindingId,
    gatewayId: binding.gatewayId,
    gatewayType: binding.gatewayType,
    conversationRef: binding.conversationRef,
    ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
    sessionRef: { scopeRef: binding.scopeRef, laneRef: binding.laneRef },
  }
}

function rejectMismatch(field: string, expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    unprocessable('interface_binding_mismatch', `${field} does not match binding`, {
      field,
      expected,
      actual,
    })
  }
}

function requireBindingField(binding: InterfaceBinding, field: 'agentId' | 'projectId'): string {
  const value = binding[field]
  if (value === undefined) {
    unprocessable('invalid_interface_binding', `interface binding is missing ${field}`, {
      bindingId: binding.bindingId,
      field,
    })
  }

  return value
}

function resolveBindingById(input: {
  body: Record<string, unknown>
  bindingId: string
  deps: Parameters<RouteHandler>[0]['deps']
}): InterfaceBinding {
  const binding = input.deps.interfaceStore.bindings.getById(input.bindingId)
  if (binding === undefined) {
    throw new AcpHttpError(404, 'interface_binding_not_found', 'interface binding not found', {
      bindingId: input.bindingId,
    })
  }

  if (binding.status !== 'active') {
    unprocessable('interface_binding_disabled', 'interface binding is disabled', {
      bindingId: binding.bindingId,
      status: binding.status,
    })
  }

  rejectMismatch(
    'gatewayType',
    readOptionalTrimmedStringField(input.body, 'gatewayType'),
    binding.gatewayType
  )
  rejectMismatch(
    'agentId',
    readOptionalTrimmedStringField(input.body, 'agentId'),
    requireBindingField(binding, 'agentId')
  )
  rejectMismatch(
    'projectId',
    readOptionalTrimmedStringField(input.body, 'projectId'),
    requireBindingField(binding, 'projectId')
  )
  rejectMismatch('laneRef', readOptionalTrimmedStringField(input.body, 'laneRef'), binding.laneRef)

  return binding
}

function resolvePrimaryBinding(input: {
  body: Record<string, unknown>
  deps: Parameters<RouteHandler>[0]['deps']
}): InterfaceBinding {
  const gatewayType = requireTrimmedStringField(input.body, 'gatewayType')
  const agentId = requireTrimmedStringField(input.body, 'agentId')
  const projectId = requireTrimmedStringField(input.body, 'projectId')
  const laneRef = readOptionalTrimmedStringField(input.body, 'laneRef') ?? 'main'
  const candidates = input.deps.interfaceStore.bindings.listPrimaryCandidates({
    gatewayType,
    agentId,
    projectId,
    laneRef,
  })

  if (candidates.length === 0) {
    throw new AcpHttpError(404, 'interface_binding_not_found', 'interface binding not found', {
      gatewayType,
      agentId,
      projectId,
      laneRef,
    })
  }

  if (candidates.length > 1) {
    throw new AcpHttpError(
      409,
      'interface_binding_ambiguous',
      'multiple interface bindings match',
      {
        gatewayType,
        agentId,
        projectId,
        laneRef,
        candidates: candidates.map(candidateDetails),
      }
    )
  }

  return candidates[0] as InterfaceBinding
}

export const handleCreateAgentPulpitMessage: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')
  const text = requireTrimmedStringField(body, 'text')
  const bindingId = readOptionalTrimmedStringField(body, 'bindingId')
  const binding =
    bindingId !== undefined
      ? resolveBindingById({ body, bindingId, deps })
      : resolvePrimaryBinding({ body, deps })

  const effectiveActor =
    parseActorFromHeaders(request.headers, undefined, deps.defaultActor) ?? deps.defaultActor

  const createdAt = new Date().toISOString()
  const result = deps.interfaceStore.deliveries.enqueueIdempotent({
    route: ROUTE,
    idempotencyKey,
    fingerprintHash: fingerprint({ binding, bodyKind: 'text/markdown', bodyText: text }),
    deliveryRequestId: `dr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    actor: effectiveActor,
    gatewayId: binding.gatewayId,
    bindingId: binding.bindingId,
    scopeRef: binding.scopeRef,
    laneRef: binding.laneRef,
    conversationRef: binding.conversationRef,
    ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
    bodyKind: 'text/markdown',
    bodyText: text,
    createdAt,
  })

  if (!result.ok && result.code === 'idempotency_conflict') {
    throw new AcpHttpError(
      409,
      'idempotency_conflict',
      'idempotency key was reused with different content',
      {
        idempotencyKey,
        existingDeliveryRequestId: result.existingDeliveryRequestId,
      }
    )
  }
  if (!result.ok) {
    throw new AcpHttpError(
      409,
      'idempotency_delivery_missing',
      'idempotency record points at a missing delivery',
      {
        idempotencyKey,
        existingDeliveryRequestId: result.existingDeliveryRequestId,
      }
    )
  }

  return json(
    {
      idempotencyKey,
      delivery: toApiDeliveryRequest(result.delivery),
    },
    result.created ? 201 : 200
  )
}
