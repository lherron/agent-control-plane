import { randomUUID } from 'node:crypto'

import type { InterfaceBinding as StoredInterfaceBinding } from 'acp-interface-store'

import { json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { parseSessionRefField } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'
import { parseInterfaceBindingStatus, toApiInterfaceBinding } from './interface-shared.js'

function findExistingBinding(input: {
  bindings: StoredInterfaceBinding[]
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}): StoredInterfaceBinding | undefined {
  return input.bindings.find(
    (binding) =>
      binding.gatewayId === input.gatewayId &&
      binding.conversationRef === input.conversationRef &&
      binding.threadRef === input.threadRef
  )
}

export const handleCreateInterfaceBinding: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const gatewayId = requireTrimmedStringField(body, 'gatewayId')
  const conversationRef = requireTrimmedStringField(body, 'conversationRef')
  const threadRef = readOptionalTrimmedStringField(body, 'threadRef')
  const projectId = readOptionalTrimmedStringField(body, 'projectId')
  const status = parseInterfaceBindingStatus(body['status'])
  const existing = findExistingBinding({
    bindings: deps.interfaceStore.bindings.list({ gatewayId, conversationRef }),
    gatewayId,
    conversationRef,
    ...(threadRef !== undefined ? { threadRef } : {}),
  })
  const timestamp = new Date().toISOString()
  const saved = deps.interfaceStore.bindings.upsertByLookup({
    bindingId: existing?.bindingId ?? `ifb_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    gatewayId,
    conversationRef,
    ...(threadRef !== undefined ? { threadRef } : {}),
    scopeRef: sessionRef.scopeRef,
    laneRef: sessionRef.laneRef,
    ...(projectId !== undefined ? { projectId } : {}),
    status,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  })

  return json({ binding: toApiInterfaceBinding(saved) }, existing === undefined ? 201 : 200)
}
