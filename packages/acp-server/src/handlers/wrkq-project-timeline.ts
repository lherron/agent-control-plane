import type { WrkqContainerTimelineViewParams } from '@wrkq/client'

import { badRequest, json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function readOptionalString(url: URL, field: string): string | undefined {
  const raw = url.searchParams.get(field)
  if (raw === null) return undefined

  const value = raw.trim()
  if (value.length === 0) {
    badRequest(`${field} must be a non-empty string`, { field })
  }
  return value
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return DEFAULT_LIMIT

  const value = Number(raw)
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`, {
      field: 'limit',
      max: MAX_LIMIT,
    })
  }
  return value
}

function readOrder(url: URL): 'asc' | 'desc' | undefined {
  const value = readOptionalString(url, 'order')
  if (value === undefined || value === 'asc' || value === 'desc') return value
  badRequest('order must be "asc" or "desc"', { field: 'order', value })
}

function readBoolean(url: URL, field: string): boolean | undefined {
  const value = readOptionalString(url, field)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  badRequest(`${field} must be "true" or "false"`, { field, value })
}

function readTypes(url: URL): string[] | undefined {
  const raw = readOptionalString(url, 'types')
  if (raw === undefined) return undefined

  const types = raw.split(',').map((type) => type.trim())
  if (types.some((type) => type.length === 0)) {
    badRequest('types values must be non-empty', { field: 'types' })
  }
  return types
}

/**
 * The `wrkp log` read through the ACP facade: one `wrkq.container.timelineView`
 * call over the project subtree, entries only, result passed through unchanged.
 */
export const handleGetWrkqProjectTimeline: RouteHandler = async ({ url, params, deps }) => {
  const project = params['project']?.trim()
  if (project === undefined || project.length === 0) {
    badRequest('project must be a project slug or container id', { field: 'project' })
  }

  const workClient = deps.workClient
  if (workClient === undefined) {
    badRequest('wrkq client is not configured')
  }

  const cursor = readOptionalString(url, 'cursor')
  const order = readOrder(url)
  const types = readTypes(url)
  const allTypes = readBoolean(url, 'allTypes')
  const tail = readBoolean(url, 'tail')
  const since = readOptionalString(url, 'since')
  const before = readOptionalString(url, 'before')
  const task = readOptionalString(url, 'task')

  // A cursor carries its own direction and tail is ascending by construction,
  // so the newest-first default applies only to a fresh, non-tail read.
  const effectiveOrder =
    cursor !== undefined ? undefined : (order ?? (tail === true ? undefined : 'desc'))

  const request: WrkqContainerTimelineViewParams = {
    container: project,
    scope: 'subtree',
    entriesOnly: true,
    limit: readLimit(url),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(effectiveOrder !== undefined ? { order: effectiveOrder } : {}),
    ...(types !== undefined ? { types } : {}),
    ...(allTypes !== undefined ? { allTypes } : {}),
    ...(tail !== undefined ? { tail } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(task !== undefined ? { task } : {}),
  }

  return json(await workClient.wrkq.container.timelineView(request))
}
