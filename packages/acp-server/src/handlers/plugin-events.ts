import { HrcDomainError, type HrcEventCategory, type HrcLifecycleEvent } from 'hrc-core'
import type { HrcEventTailOptions, WatchBoundedEventsOptions } from 'hrc-sdk'

import type { AcpHrcClient } from '../deps.js'
import { AcpHttpError, json } from '../http.js'
import { isRecord, parseJsonBody } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  PluginEventCursorError,
  decodePluginEventCursor,
  encodePluginEventCursor,
} from './plugin-event-cursor.js'

const FILTER_NAMES = [
  'sourceRef',
  'hostSessionId',
  'generation',
  'scopeRef',
  'laneRef',
  'runtimeId',
  'runId',
  'category',
  'eventKind',
] as const

const STRING_FILTER_NAMES = FILTER_NAMES.filter((name) => name !== 'generation')

export type AcpPluginEventFilters = {
  sourceRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  category?: string | undefined
  eventKind?: string | undefined
}

export class PluginEventRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'PluginEventRequestError'
    this.code = code
    this.status = status
  }
}

export type ResolvedPluginEventCursor = {
  cursor: string
  ledgerIncarnationId: string
  hrcSeq: number
  headCursor: string
  headHrcSeq: number
}

function resultSuccess<T>(value: T): Response {
  return json({ ok: true, value, error: null })
}

function resultFailure(code: string, message: string, status: number): Response {
  return json({ ok: false, value: null, error: { code, message } }, status)
}

function routeError(error: unknown): Response {
  if (error instanceof PluginEventRequestError) {
    return resultFailure(error.code, error.message, error.status)
  }
  if (error instanceof PluginEventCursorError) {
    return resultFailure(error.code, error.message, 400)
  }
  if (error instanceof AcpHttpError) {
    return resultFailure(error.code, error.message, error.status)
  }
  if (error instanceof HrcDomainError) {
    return resultFailure(error.code, error.message, error.status)
  }
  return resultFailure('internal_error', 'internal server error', 500)
}

function requireHrcClient(client: AcpHrcClient | undefined): AcpHrcClient {
  if (client === undefined) {
    throw new PluginEventRequestError('runtime_unavailable', 'hrcClient not configured', 503)
  }
  return client
}

export function assertOnlySearchParams(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key)) {
      throw new PluginEventRequestError('malformed_request', `unsupported query parameter: ${key}`)
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new PluginEventRequestError('malformed_request', `query parameter ${key} is duplicated`)
    }
  }
}

export function parsePluginEventFilters(url: URL): AcpPluginEventFilters {
  const filters: AcpPluginEventFilters = {}
  for (const name of STRING_FILTER_NAMES) {
    const value = url.searchParams.get(name)
    if (value === null) continue
    if (value.length === 0) {
      throw new PluginEventRequestError('malformed_request', `${name} must be non-empty`)
    }
    filters[name] = value
  }

  const generationRaw = url.searchParams.get('generation')
  if (generationRaw !== null) {
    if (!/^(0|[1-9]\d*)$/.test(generationRaw)) {
      throw new PluginEventRequestError(
        'malformed_request',
        'generation must be a non-negative integer'
      )
    }
    const generation = Number(generationRaw)
    if (!Number.isSafeInteger(generation)) {
      throw new PluginEventRequestError('malformed_request', 'generation must be a safe integer')
    }
    filters.generation = generation
  }
  return filters
}

export function toHrcEventFilters(
  filters: AcpPluginEventFilters
): Omit<HrcEventTailOptions, 'limit'> &
  Omit<WatchBoundedEventsOptions, 'ledgerIncarnationId' | 'afterSeq' | 'signal'> {
  const { category, ...rest } = filters
  return {
    ...rest,
    ...(category !== undefined ? { category: category as HrcEventCategory } : {}),
  }
}

export function pluginEventMatchesFilters(
  event: HrcLifecycleEvent,
  filters: AcpPluginEventFilters
): boolean {
  for (const name of FILTER_NAMES) {
    const expected = filters[name]
    if (expected !== undefined && event[name] !== expected) return false
  }
  return true
}

export async function resolvePluginEventCursor(
  client: AcpHrcClient,
  cursor: string
): Promise<ResolvedPluginEventCursor> {
  const authority = await client.tailEvents({ limit: 1 })
  const headCursor = encodePluginEventCursor({
    ledgerIncarnationId: authority.ledgerIncarnationId,
    hrcSeq: authority.headHrcSeq,
  })

  if (cursor === 'now') {
    return {
      cursor: headCursor,
      ledgerIncarnationId: authority.ledgerIncarnationId,
      hrcSeq: authority.headHrcSeq,
      headCursor,
      headHrcSeq: authority.headHrcSeq,
    }
  }

  const decoded = decodePluginEventCursor(cursor)
  if (decoded.ledgerIncarnationId !== authority.ledgerIncarnationId) {
    throw new PluginEventRequestError(
      'cursor_invalid',
      'event ledger incarnation is no longer current',
      409
    )
  }
  if (decoded.hrcSeq > authority.headHrcSeq) {
    throw new PluginEventRequestError(
      'cursor_future',
      'cursor position is ahead of the current event ledger head',
      409
    )
  }
  return {
    cursor,
    ledgerIncarnationId: decoded.ledgerIncarnationId,
    hrcSeq: decoded.hrcSeq,
    headCursor,
    headHrcSeq: authority.headHrcSeq,
  }
}

const TAIL_QUERY_NAMES = new Set<string>(['limit', ...FILTER_NAMES])

export const handlePluginEventsTail: RouteHandler = async ({ deps, url }) => {
  try {
    assertOnlySearchParams(url, TAIL_QUERY_NAMES)
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit === null || !/^[1-9]\d*$/.test(rawLimit)) {
      throw new PluginEventRequestError(
        'malformed_request',
        'limit is required and must be an integer from 1 through 500'
      )
    }
    const limit = Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit > 500) {
      throw new PluginEventRequestError(
        'malformed_request',
        'limit must be an integer from 1 through 500'
      )
    }
    const filters = parsePluginEventFilters(url)
    const tail = await requireHrcClient(deps.hrcClient).tailEvents({
      limit,
      ...toHrcEventFilters(filters),
    })
    return resultSuccess({
      events: tail.events,
      cursor: encodePluginEventCursor({
        ledgerIncarnationId: tail.ledgerIncarnationId,
        hrcSeq: tail.headHrcSeq,
      }),
      truncated: tail.truncated,
    })
  } catch (error) {
    return routeError(error)
  }
}

export const handleResolvePluginEventCursor: RouteHandler = async ({ deps, request }) => {
  try {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body['cursor'] !== 'string') {
      throw new PluginEventRequestError(
        'malformed_request',
        'body must contain only a string cursor field'
      )
    }
    const cursor = body['cursor']
    if (cursor.length === 0) {
      throw new PluginEventRequestError('malformed_request', 'cursor must be non-empty')
    }
    const resolved = await resolvePluginEventCursor(requireHrcClient(deps.hrcClient), cursor)
    return resultSuccess(resolved)
  } catch (error) {
    return routeError(error)
  }
}

export const handlePluginEventsUpgradeRequired: RouteHandler = () =>
  resultFailure('upgrade_required', 'Use a WebSocket upgrade for /v1/plugins/events.', 426)
