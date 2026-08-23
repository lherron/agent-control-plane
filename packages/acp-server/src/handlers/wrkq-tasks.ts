import type {
  WorkClient,
  WrkqComment,
  WrkqRelation,
  WrkqTask,
  WrkqTaskListParams,
  WrkqTaskState,
} from '@wrkq/client'

import { badRequest, json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const DEFAULT_COMMENT_LIMIT = 5
const MAX_COMMENT_LIMIT = 25
const COMMENT_PAGE_SIZE = 500
const WRKQ_TASK_ID = /^T-[0-9]+$/

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

function readCommentLimit(url: URL): number {
  const raw = url.searchParams.get('comments')
  if (raw === null) return DEFAULT_COMMENT_LIMIT

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > MAX_COMMENT_LIMIT) {
    badRequest(`comments must be an integer between 0 and ${MAX_COMMENT_LIMIT}`, {
      field: 'comments',
      max: MAX_COMMENT_LIMIT,
    })
  }
  return value
}

function optionalMetaString(task: WrkqTask, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = task.meta[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function projectTaskDetail(task: WrkqTask) {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    priority: task.priority,
    kind: task.kind,
    project: task.path.split('/', 1)[0] ?? '',
    path: task.path,
    labels: task.labels,
    assignee: task.assigneePrincipalRef ?? null,
    assigneePrincipalRef: task.assigneePrincipalRef ?? null,
    claimedBy: task.claimedBy ?? null,
    claimedScope: task.claimedScope ?? null,
    claimedNode: task.claimedNode ?? null,
    claimedAt: task.claimedAt ?? null,
    claimGeneration: task.claimGeneration ?? null,
    description: task.description,
    specification: task.specification,
    outcome: task.outcome ?? null,
    resolution: optionalMetaString(task, 'resolution'),
    workflowPreset: optionalMetaString(task, 'workflowPreset', 'workflow_preset'),
    phase: optionalMetaString(task, 'phase'),
    riskClass: task.riskClass ?? null,
    startAt: task.startAt ?? null,
    dueAt: task.dueAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    acknowledgedAt: task.acknowledgedAt ?? null,
    etag: task.etag,
  }
}

function projectComment(comment: WrkqComment) {
  return {
    id: comment.id,
    kind: comment.kind ?? null,
    body: comment.body,
    author: comment.createdByPrincipalRef ?? null,
    principalRef: comment.createdByPrincipalRef ?? null,
    scopeRef: null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt ?? null,
  }
}

function projectRelation(relation: WrkqRelation) {
  return {
    fromTask: relation.fromTask,
    toTask: relation.toTask,
    kind: relation.kind,
    direction: relation.direction ?? null,
    createdAt: relation.createdAt ?? null,
  }
}

async function readLatestComments(
  workClient: WorkClient,
  taskId: string,
  limit: number
): Promise<WrkqComment[]> {
  if (limit === 0) return []

  let cursor: string | undefined
  const seenCursors = new Set<string>()
  let latest: WrkqComment[] = []

  do {
    const page = await workClient.wrkq.comment.list({
      task: taskId,
      limit: COMMENT_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    latest = latest.concat(page.items).slice(-limit)
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`wrkq.comment.list repeated cursor for ${taskId}`)
      }
      seenCursors.add(cursor)
    }
  } while (cursor !== undefined)

  return latest.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
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

export const handleGetWrkqTask: RouteHandler = async ({ url, params, deps }) => {
  const taskId = params['taskId']?.trim()
  if (taskId === undefined || !WRKQ_TASK_ID.test(taskId)) {
    badRequest('taskId must be a wrkq id such as T-00001', {
      field: 'taskId',
      value: taskId ?? null,
    })
  }

  const workClient = deps.workClient
  if (workClient === undefined) {
    badRequest('wrkq client is not configured')
  }

  const commentLimit = readCommentLimit(url)
  const task = await workClient.wrkq.task.show({ task: taskId })
  const [comments, relations] = await Promise.all([
    readLatestComments(workClient, taskId, commentLimit),
    workClient.wrkq.relation.list({ task: taskId }),
  ])

  return json({
    task: projectTaskDetail(task),
    comments: comments.map(projectComment),
    relations: relations.items.map(projectRelation),
  })
}
