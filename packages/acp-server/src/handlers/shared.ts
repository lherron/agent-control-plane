import { type EvidenceItem, type Task, computeTaskContext } from 'acp-core'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import { badRequest, notFound } from '../http.js'
import {
  isRecord,
  readOptionalArrayField,
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireNumberField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

export function requireTaskId(params: Record<string, string>): string {
  const taskId = params['taskId']
  if (taskId === undefined || taskId.length === 0) {
    badRequest('taskId route param is required', { field: 'taskId' })
  }

  return taskId
}

export function requireRunId(params: Record<string, string>): string {
  const runId = params['runId']
  if (runId === undefined || runId.length === 0) {
    badRequest('runId route param is required', { field: 'runId' })
  }

  return runId
}

export function requireTask(task: Task | undefined, taskId: string): Task {
  if (task === undefined) {
    notFound(`task not found: ${taskId}`, { taskId })
  }

  return task
}

export function parseRoleMap(input: unknown): Record<string, string> {
  const roleMap = requireRecord(input, 'roleMap')
  const entries = Object.entries(roleMap)
  if (entries.length === 0) {
    badRequest('roleMap must include at least one role assignment', { field: 'roleMap' })
  }

  return entries.reduce<Record<string, string>>((result, [role, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      badRequest(`roleMap.${role} must be a non-empty string`, { field: `roleMap.${role}` })
    }

    result[role] = value.trim()
    return result
  }, {})
}

function parseEvidenceBuild(input: unknown, field: string): EvidenceItem['build'] {
  const build = requireRecord(input, field)
  const id = readOptionalTrimmedStringField(build, 'id')
  const version = readOptionalTrimmedStringField(build, 'version')
  const env = readOptionalTrimmedStringField(build, 'env')

  return {
    ...(id !== undefined ? { id } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(env !== undefined ? { env } : {}),
  }
}

function parseEvidenceProducedBy(input: unknown, field: string): EvidenceItem['producedBy'] {
  const producedBy = requireRecord(input, field)
  return {
    agentId: requireTrimmedStringField(producedBy, 'agentId'),
    ...(readOptionalTrimmedStringField(producedBy, 'role') !== undefined
      ? { role: readOptionalTrimmedStringField(producedBy, 'role') }
      : {}),
  }
}

export function parseEvidenceItems(input: unknown, field = 'evidence'): EvidenceItem[] {
  if (!Array.isArray(input)) {
    badRequest(`${field} must be an array`, { field })
  }

  return input.map((entry, index) => {
    const item = requireRecord(entry, `${field}[${index}]`)
    const producedBy = item['producedBy']
    const build = item['build']
    const details = item['details']
    if (details !== undefined && !isRecord(details)) {
      badRequest(`${field}[${index}].details must be an object`, {
        field: `${field}[${index}].details`,
      })
    }

    return {
      kind: requireTrimmedStringField(item, 'kind'),
      ref: requireTrimmedStringField(item, 'ref'),
      ...(readOptionalTrimmedStringField(item, 'contentHash') !== undefined
        ? { contentHash: readOptionalTrimmedStringField(item, 'contentHash') }
        : {}),
      ...(producedBy !== undefined
        ? { producedBy: parseEvidenceProducedBy(producedBy, `${field}[${index}].producedBy`) }
        : {}),
      ...(readOptionalTrimmedStringField(item, 'timestamp') !== undefined
        ? { timestamp: readOptionalTrimmedStringField(item, 'timestamp') }
        : {}),
      ...(build !== undefined
        ? { build: parseEvidenceBuild(build, `${field}[${index}].build`) }
        : {}),
      ...(details !== undefined ? { details } : {}),
    } satisfies EvidenceItem
  })
}

export function parseSessionRefField(input: Record<string, unknown>, field: string): SessionRef {
  const raw = requireRecord(input[field], field)
  const laneRef = readOptionalTrimmedStringField(raw, 'laneRef')

  return normalizeSessionRef({
    scopeRef: requireTrimmedStringField(raw, 'scopeRef'),
    ...(laneRef !== undefined ? { laneRef } : {}),
  })
}

export function determineContextRole(input: {
  task: Task
  request: Request
  roleFromQuery?: string | undefined
}): string | undefined {
  if (input.roleFromQuery !== undefined) {
    return input.roleFromQuery
  }

  const actorAgentId = input.request.headers.get('x-acp-actor-agent-id')?.trim()
  if (actorAgentId === undefined || actorAgentId.length === 0) {
    return undefined
  }

  const matchedRoles = Object.entries(input.task.roleMap)
    .filter(([, agentId]) => agentId === actorAgentId)
    .map(([role]) => role)

  return matchedRoles.length === 1 ? matchedRoles[0] : undefined
}

export function maybeComputeTaskContext(input: {
  task: Task
  request: Request
  roleFromQuery?: string | undefined
  getPreset(presetId: string, version: number): Parameters<typeof computeTaskContext>[0]['preset']
}): ReturnType<typeof computeTaskContext> | undefined {
  if (input.task.workflowPreset === undefined || input.task.presetVersion === undefined) {
    return undefined
  }

  const role = determineContextRole(input)
  if (role === undefined) {
    return undefined
  }

  const preset = input.getPreset(input.task.workflowPreset, input.task.presetVersion)
  return computeTaskContext({ preset, task: input.task, role })
}

export function taskIdFromSessionRef(sessionRef: SessionRef): string | undefined {
  const parsed = parseScopeRef(sessionRef.scopeRef)
  return parsed.taskId
}

export function parseEvidenceRefs(input: Record<string, unknown>): string[] | undefined {
  const evidenceRefs = readOptionalArrayField(input, 'evidenceRefs')
  if (evidenceRefs === undefined) {
    return undefined
  }

  return evidenceRefs.map((value, index) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      badRequest(`evidenceRefs[${index}] must be a non-empty string`, {
        field: `evidenceRefs[${index}]`,
      })
    }

    return value.trim()
  })
}

export function parseTransitionRequestBody(body: unknown): {
  toPhase: string
  expectedVersion: number
  idempotencyKey?: string | undefined
  requestHandoff?: boolean | undefined
  evidenceRefs?: string[] | undefined
  waivers?: EvidenceItem[] | undefined
} {
  const input = requireRecord(body)
  return {
    toPhase: requireTrimmedStringField(input, 'toPhase'),
    expectedVersion: requireNumberField(input, 'expectedVersion'),
    ...(readOptionalTrimmedStringField(input, 'idempotencyKey') !== undefined
      ? { idempotencyKey: readOptionalTrimmedStringField(input, 'idempotencyKey') }
      : {}),
    ...(input['requestHandoff'] !== undefined
      ? { requestHandoff: input['requestHandoff'] === true }
      : {}),
    ...(parseEvidenceRefs(input) !== undefined ? { evidenceRefs: parseEvidenceRefs(input) } : {}),
    ...(readOptionalArrayField(input, 'waivers') !== undefined
      ? { waivers: parseEvidenceItems(readOptionalArrayField(input, 'waivers'), 'waivers') }
      : {}),
  }
}

export function readOptionalMeta(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  return readOptionalRecordField(input, 'meta')
}
