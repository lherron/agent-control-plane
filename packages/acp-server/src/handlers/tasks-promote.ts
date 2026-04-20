import { randomUUID } from 'node:crypto'

import type { LoggedTransitionRecord, Preset, RiskClass, Task } from 'acp-core'

import { AcpHttpError, json, unprocessable } from '../http.js'
import { extractActor } from '../parsers/actor.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireNumberField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { parseRoleMap, requireTask, requireTaskId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

const ALLOWED_RISK_CLASSES = new Set<RiskClass>(['low', 'medium', 'high'])

function resolvePreset(input: {
  getPreset(presetId: string, version: number): Preset
  presetId: string
  version: number
}): Preset {
  try {
    return input.getPreset(input.presetId, input.version)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown ACP preset:')) {
      unprocessable('unknown_preset', error.message, {
        workflowPreset: input.presetId,
        presetVersion: input.version,
      })
    }

    throw error
  }
}

function parseRiskClass(body: Record<string, unknown>): RiskClass {
  const riskClass = requireTrimmedStringField(body, 'riskClass') as RiskClass
  if (!ALLOWED_RISK_CLASSES.has(riskClass)) {
    unprocessable('invalid_risk_class', 'riskClass must be one of: low, medium, high', {
      riskClass,
    })
  }

  return riskClass
}

function requireDefaultPhase(preset: Preset): string {
  const phase = preset.phaseGraph[0]
  if (phase === undefined) {
    throw new Error(`ACP preset ${preset.presetId}@${preset.version} has no phases`)
  }

  return phase
}

function readExistingAcpMeta(task: Task): Record<string, unknown> {
  const meta = task.meta?.['acp']
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? { ...(meta as Record<string, unknown>) }
    : {}
}

function buildPromotedTask(input: {
  task: Task
  workflowPreset: string
  presetVersion: number
  phase: string
  riskClass: RiskClass
  roleMap: Record<string, string>
}): Task {
  return {
    ...input.task,
    workflowPreset: input.workflowPreset,
    presetVersion: input.presetVersion,
    phase: input.phase,
    riskClass: input.riskClass,
    roleMap: input.roleMap,
    meta: {
      ...(input.task.meta ?? {}),
      acp: {
        ...readExistingAcpMeta(input.task),
        promoted: true,
        fromKind: input.task.kind,
      },
    },
  }
}

export const handlePromoteTask: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body)
  const roleMap = parseRoleMap(body['roleMap'])
  if (roleMap['implementer'] === undefined) {
    unprocessable('implementer_required', 'roleMap must include an implementer assignment', {
      field: 'roleMap.implementer',
    })
  }

  const task = requireTask(deps.wrkqStore.taskRepo.getTask(taskId), taskId)
  if (task.workflowPreset !== undefined || task.presetVersion !== undefined) {
    throw new AcpHttpError(
      409,
      'already_preset_driven',
      `task ${taskId} is already pinned to a workflow preset`,
      { taskId }
    )
  }

  const workflowPreset = requireTrimmedStringField(body, 'workflowPreset')
  const presetVersion = requireNumberField(body, 'presetVersion')
  const preset = resolvePreset({
    getPreset: deps.presetRegistry.getPreset.bind(deps.presetRegistry),
    presetId: workflowPreset,
    version: presetVersion,
  })
  const riskClass = parseRiskClass(body)
  const initialPhase =
    readOptionalTrimmedStringField(body, 'initialPhase') ?? requireDefaultPhase(preset)
  if (!preset.phaseGraph.includes(initialPhase)) {
    unprocessable(
      'invalid_initial_phase',
      `initialPhase must be one of preset phaseGraph: ${preset.phaseGraph.join(', ')}`,
      { initialPhase, workflowPreset, presetVersion }
    )
  }

  const actorRole = actor?.role ?? 'triager'
  const promotedTask = buildPromotedTask({
    task,
    workflowPreset,
    presetVersion,
    phase: initialPhase,
    riskClass,
    roleMap,
  })

  const transition: LoggedTransitionRecord = {
    taskId,
    transitionEventId: `tte_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    from: {
      lifecycleState: task.lifecycleState,
      phase: task.phase,
    },
    to: {
      lifecycleState: task.lifecycleState,
      phase: initialPhase,
    },
    actor: {
      agentId: actor?.agentId ?? '',
      role: actorRole,
    },
    requiredEvidenceKinds: [],
    evidenceKinds: [],
    waivedEvidenceKinds: [],
    expectedVersion: task.version,
    nextVersion: task.version + 1,
  }

  const updatedTask = deps.wrkqStore.runInTransaction((store) => {
    const persisted = store.taskRepo.updateTask({
      ...promotedTask,
      version: task.version,
    })
    store.roleAssignmentRepo.setRoleMap(taskId, roleMap)
    store.transitionLogRepo.appendTransition(taskId, transition)
    return persisted
  })

  return json({ task: updatedTask, transition })
}
