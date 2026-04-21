import { badRequest } from '../http.js'
import { json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'
import { toApiInterfaceBinding } from './interface-shared.js'

function readOptionalQueryParam(url: URL, field: string): string | undefined {
  const rawValue = url.searchParams.get(field)
  if (rawValue !== null && rawValue.trim().length === 0) {
    badRequest(`${field} must be a non-empty string`, { field })
  }

  const value = rawValue?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

export const handleListInterfaceBindings: RouteHandler = async ({ url, deps }) => {
  const bindings = deps.interfaceStore.bindings.list({
    ...(readOptionalQueryParam(url, 'gatewayId') !== undefined
      ? { gatewayId: readOptionalQueryParam(url, 'gatewayId') }
      : {}),
    ...(readOptionalQueryParam(url, 'conversationRef') !== undefined
      ? { conversationRef: readOptionalQueryParam(url, 'conversationRef') }
      : {}),
    ...(readOptionalQueryParam(url, 'threadRef') !== undefined
      ? { threadRef: readOptionalQueryParam(url, 'threadRef') }
      : {}),
    ...(readOptionalQueryParam(url, 'projectId') !== undefined
      ? { projectId: readOptionalQueryParam(url, 'projectId') }
      : {}),
  })

  return json({ bindings: bindings.map(toApiInterfaceBinding) })
}
