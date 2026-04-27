import type { RoleMap, Task, TaskLifecycleState } from 'acp-core'

import { isRecord, parseJsonRecord, stableStringify } from '../json.js'

export type TaskRow = {
  id: string
  project_id: string
  state: string
  workflow_preset: string | null
  preset_version: number | null
  phase: string | null
  risk_class: string | null
  etag: number
  meta: string | null
  wrkq_kind: string
}

export type TaskWriteRecord = {
  id: string
  slug: string
  title: string
  projectUuid: string
  state: string
  workflowPreset: string | null
  presetVersion: number | null
  phase: string | null
  riskClass: string | null
  meta: string | null
  version: number
  actorUuid: string
}

function mapWrkqStateToLifecycleState(state: string): TaskLifecycleState {
  if (state === 'in_progress') {
    return 'active'
  }

  return state
}

function mapLifecycleStateToWrkqState(state: TaskLifecycleState): string {
  if (state === 'active') {
    return 'in_progress'
  }

  return state
}

function normalizePresetColumns(task: Task): {
  workflowPreset: string | null
  presetVersion: number | null
  phase: string | null
} {
  if (task.workflowPreset === undefined && task.presetVersion === undefined) {
    if (task.phase !== null && task.phase !== '') {
      throw new Error('Non-preset ACP tasks must have phase=null')
    }

    return {
      workflowPreset: null,
      presetVersion: null,
      phase: null,
    }
  }

  if (task.workflowPreset === undefined || task.presetVersion === undefined) {
    throw new Error('workflowPreset and presetVersion must either both be set or both be unset')
  }

  return {
    workflowPreset: task.workflowPreset,
    presetVersion: task.presetVersion,
    phase: task.phase,
  }
}

function encodeTaskMeta(task: Task): string {
  const root = task.meta !== undefined ? { ...task.meta } : {}
  const existingAcp = isRecord(root['acp']) ? { ...root['acp'] } : {}
  existingAcp['kind'] = task.kind
  root['acp'] = existingAcp
  return stableStringify(root)
}

function decodeTaskMeta(
  meta: string | null,
  fallbackKind: string
): { kind: string; meta?: Readonly<Record<string, unknown>> | undefined } {
  const parsed = parseJsonRecord(meta)
  if (parsed === undefined) {
    return { kind: fallbackKind }
  }

  const acp = isRecord(parsed['acp']) ? { ...parsed['acp'] } : undefined
  const kindValue = typeof acp?.['kind'] === 'string' ? acp['kind'] : fallbackKind

  let cleaned: Record<string, unknown> = parsed
  if (acp !== undefined) {
    const { kind: _drop, ...acpRest } = acp
    if (Object.keys(acpRest).length === 0) {
      const { acp: _omit, ...withoutAcp } = parsed
      cleaned = withoutAcp
    } else {
      cleaned = { ...parsed, acp: acpRest }
    }
  }

  return Object.keys(cleaned).length === 0
    ? { kind: kindValue }
    : { kind: kindValue, meta: cleaned }
}

export function mapTaskRow(row: TaskRow, roleMap: RoleMap): Task {
  const decodedMeta = decodeTaskMeta(row.meta, row.wrkq_kind)

  return {
    taskId: row.id,
    projectId: row.project_id,
    kind: decodedMeta.kind,
    ...(row.workflow_preset !== null ? { workflowPreset: row.workflow_preset } : {}),
    ...(row.preset_version !== null ? { presetVersion: row.preset_version } : {}),
    lifecycleState: mapWrkqStateToLifecycleState(row.state),
    phase: row.phase ?? '',
    ...(row.risk_class !== null ? { riskClass: row.risk_class } : {}),
    roleMap,
    version: row.etag,
    ...(decodedMeta.meta !== undefined ? { meta: decodedMeta.meta } : {}),
  }
}

export function mapTaskToWriteRecord(input: {
  task: Task
  projectUuid: string
  actorUuid: string
  slug: string
}): TaskWriteRecord {
  const presetColumns = normalizePresetColumns(input.task)

  return {
    id: input.task.taskId,
    slug: input.slug,
    title: input.task.taskId,
    projectUuid: input.projectUuid,
    state: mapLifecycleStateToWrkqState(input.task.lifecycleState),
    workflowPreset: presetColumns.workflowPreset,
    presetVersion: presetColumns.presetVersion,
    phase: presetColumns.phase,
    riskClass: input.task.riskClass ?? null,
    meta: encodeTaskMeta(input.task),
    version: input.task.version,
    actorUuid: input.actorUuid,
  }
}
