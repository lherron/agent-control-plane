import { randomUUID } from 'node:crypto'

import type { Task } from 'acp-core'

import { json, unprocessable } from '../http.js'
import { extractActor } from '../parsers/actor.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { parseRoleMap, readOptionalMeta } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

function createTaskId(): string {
  return `T-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

export const handleCreateTask: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  extractActor(request, body)

  const workflowPreset = readOptionalTrimmedStringField(body, 'workflowPreset')
  const presetVersionValue = body['presetVersion']
  const presetVersion = typeof presetVersionValue === 'number' ? presetVersionValue : undefined
  if ((workflowPreset === undefined) !== (presetVersion === undefined)) {
    throw new Error('workflowPreset and presetVersion must be provided together')
  }

  const preset =
    workflowPreset !== undefined && presetVersion !== undefined
      ? deps.presetRegistry.getPreset(workflowPreset, presetVersion)
      : undefined

  // Reject phase when workflowPreset is absent
  const explicitPhase = readOptionalTrimmedStringField(body, 'phase')
  if (explicitPhase !== undefined && preset === undefined) {
    unprocessable('phase_requires_preset', 'phase is only valid when workflowPreset is set', {
      field: 'phase',
    })
  }

  const task: Task = {
    taskId: readOptionalTrimmedStringField(body, 'taskId') ?? createTaskId(),
    projectId: requireTrimmedStringField(body, 'projectId'),
    kind: readOptionalTrimmedStringField(body, 'kind') ?? preset?.kind ?? 'task',
    ...(workflowPreset !== undefined ? { workflowPreset } : {}),
    ...(presetVersion !== undefined ? { presetVersion } : {}),
    lifecycleState: 'open',
    phase: preset !== undefined ? (preset.phaseGraph[0] ?? null) : null,
    ...(readOptionalTrimmedStringField(body, 'riskClass') !== undefined
      ? { riskClass: readOptionalTrimmedStringField(body, 'riskClass') }
      : {}),
    roleMap: parseRoleMap(body['roleMap']),
    version: 0,
    ...(readOptionalMeta(body) !== undefined ? { meta: readOptionalMeta(body) } : {}),
  }

  const createdTask = deps.wrkqStore.runInTransaction((store) => {
    const created = store.taskRepo.createTask(task)
    store.roleAssignmentRepo.setRoleMap(created.taskId, task.roleMap)
    return created
  })

  return json({ task: createdTask }, 201)
}
