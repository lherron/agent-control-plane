import { badRequest, json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

function requirePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    badRequest('payload must be an object', { field: 'payload' })
  }

  return value as Record<string, unknown>
}

function readOptionalQueryValue(url: URL, field: string): string | undefined {
  const value = url.searchParams.get(field)?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

export const handleAppendSystemEvent: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const event = deps.adminStore.systemEvents.append({
    projectId: requireTrimmedStringField(body, 'projectId'),
    kind: requireTrimmedStringField(body, 'kind'),
    payload: requirePayload(body['payload']),
    occurredAt: requireTrimmedStringField(body, 'occurredAt'),
    recordedAt: new Date().toISOString(),
  })

  return json({ event }, 201)
}

export const handleListSystemEvents: RouteHandler = async ({ url, deps }) => {
  return json({
    events: deps.adminStore.systemEvents.list({
      ...(readOptionalQueryValue(url, 'projectId') !== undefined
        ? { projectId: readOptionalQueryValue(url, 'projectId') }
        : {}),
      ...(readOptionalQueryValue(url, 'kind') !== undefined
        ? { kind: readOptionalQueryValue(url, 'kind') }
        : {}),
      ...(readOptionalQueryValue(url, 'occurredAfter') !== undefined
        ? { occurredAfter: readOptionalQueryValue(url, 'occurredAfter') }
        : {}),
      ...(readOptionalQueryValue(url, 'occurredBefore') !== undefined
        ? { occurredBefore: readOptionalQueryValue(url, 'occurredBefore') }
        : {}),
    }),
  })
}
