import { badRequest, json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

function readOptionalQueryValue(url: URL, field: string): string | undefined {
  const value = url.searchParams.get(field)
  if (value !== null && value.trim().length === 0) {
    badRequest(`${field} must be a non-empty string`, { field })
  }

  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

export const handleRegisterInterfaceIdentity: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const gatewayId = requireTrimmedStringField(body, 'gatewayId')
  const externalId = requireTrimmedStringField(body, 'externalId')
  const displayName = readOptionalTrimmedStringField(body, 'displayName')
  const linkedAgentId = readOptionalTrimmedStringField(body, 'linkedAgentId')
  const existing = deps.adminStore.interfaceIdentities.getByCompositeKey({ gatewayId, externalId })
  const interfaceIdentity = deps.adminStore.interfaceIdentities.register({
    gatewayId,
    externalId,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(linkedAgentId !== undefined ? { linkedAgentId } : {}),
    now: new Date().toISOString(),
  })

  return json({ interfaceIdentity }, existing === undefined ? 201 : 200)
}

export const handleListInterfaceIdentities: RouteHandler = async ({ url, deps }) => {
  return json({
    interfaceIdentities: deps.adminStore.interfaceIdentities.list({
      ...(readOptionalQueryValue(url, 'gateway') !== undefined
        ? { gatewayId: readOptionalQueryValue(url, 'gateway') }
        : {}),
      ...(readOptionalQueryValue(url, 'externalId') !== undefined
        ? { externalId: readOptionalQueryValue(url, 'externalId') }
        : {}),
    }),
  })
}
