import type { WrkqTask, WrkqTaskListParams, WrkqTaskState } from '@wrkq/client'

import { badRequest, json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

const TASK_STATES = new Set<WrkqTaskState>([
  'idea',
  'draft',
  'open',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
  'archived',
  'deleted',
])

const SORT_FIELDS = new Set<NonNullable<WrkqTaskListParams['sort']>>([
  'created_at',
  'updated_at',
  'priority',
  'id',
  'path',
])

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
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`, {
      field: 'limit',
      max: MAX_LIMIT,
    })
  }
  return value
}

function readStates(url: URL): WrkqTaskState[] | undefined {
  const rawValues = url.searchParams.getAll('state')
  if (rawValues.length === 0) return undefined

  const states = rawValues.flatMap((raw) => raw.split(',')).map((state) => state.trim())
  if (states.some((state) => state.length === 0)) {
    badRequest('state values must be non-empty', { field: 'state' })
  }

  for (const state of states) {
    if (!TASK_STATES.has(state as WrkqTaskState)) {
      badRequest(`unsupported task state: ${state}`, { field: 'state', value: state })
    }
  }

  return [...new Set(states)] as WrkqTaskState[]
}

function readSort(url: URL): NonNullable<WrkqTaskListParams['sort']> {
  const value = readOptionalString(url, 'sort') ?? 'updated_at'
  if (!SORT_FIELDS.has(value as NonNullable<WrkqTaskListParams['sort']>)) {
    badRequest(`unsupported sort field: ${value}`, { field: 'sort', value })
  }
  return value as NonNullable<WrkqTaskListParams['sort']>
}

function readDirection(url: URL): NonNullable<WrkqTaskListParams['direction']> {
  const value = readOptionalString(url, 'direction') ?? 'desc'
  if (value !== 'asc' && value !== 'desc') {
    badRequest('direction must be "asc" or "desc"', { field: 'direction', value })
  }
  return value
}

function readRecursive(url: URL): boolean | undefined {
  const value = readOptionalString(url, 'recursive')
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  badRequest('recursive must be "true" or "false"', { field: 'recursive', value })
}

function projectTask(task: WrkqTask) {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    priority: task.priority,
    kind: task.kind,
    path: task.path,
    project: task.path.split('/', 1)[0] ?? '',
    updatedAt: task.updatedAt,
  }
}

export const handleListWrkqTasks: RouteHandler = async ({ url, deps }) => {
  const workClient = deps.workClient
  if (workClient === undefined) {
    badRequest('wrkq client is not configured')
  }

  const project = readOptionalString(url, 'project')
  const path = readOptionalString(url, 'path')
  if (project?.includes('/')) {
    badRequest('project must be a project slug, not a container path', { field: 'project' })
  }
  if (project !== undefined && path !== undefined) {
    badRequest('project and path cannot be combined', { fields: ['project', 'path'] })
  }

  const states = readStates(url)
  const recursive = readRecursive(url)
  const cursor = readOptionalString(url, 'cursor')
  const result = await workClient.wrkq.task.list({
    ...(project !== undefined ? { path: project } : path !== undefined ? { path } : {}),
    ...(states !== undefined ? { state: states } : {}),
    limit: readLimit(url),
    sort: readSort(url),
    direction: readDirection(url),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(recursive !== undefined ? { recursive } : project !== undefined ? { recursive: true } : {}),
    summary: true,
  })

  return json({
    tasks: result.items.map(projectTask),
    nextCursor: result.nextCursor ?? null,
  })
}
