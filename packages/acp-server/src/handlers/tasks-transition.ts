import { randomUUID } from 'node:crypto'

import { type LoggedTransitionRecord, applyTransitionDecision, validateTransition } from 'acp-core'

import { json, unprocessable } from '../http.js'
import {
  appendTesterHandoffOnTransition,
  shouldDeclareTesterHandoff,
} from '../integration/handoff-on-transition.js'
import { extractActor } from '../parsers/actor.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseTransitionRequestBody, requireTask, requireTaskId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleApplyTaskTransition: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { requireRole: true })
  const parsed = parseTransitionRequestBody(body)
  const task = requireTask(deps.wrkqStore.taskRepo.getTask(taskId), taskId)

  if (task.workflowPreset === undefined || task.presetVersion === undefined) {
    unprocessable('workflow_preset_required', `task ${taskId} is not pinned to a workflow preset`, {
      taskId,
    })
  }

  const roleMap = deps.wrkqStore.roleAssignmentRepo.getRoleMap(taskId) ?? task.roleMap
  const attachedEvidence = deps.wrkqStore.evidenceRepo.listEvidence(taskId)
  const selectedEvidence =
    parsed.evidenceRefs === undefined
      ? attachedEvidence
      : attachedEvidence.filter((item) => parsed.evidenceRefs?.includes(item.ref) === true)
  const preset = deps.presetRegistry.getPreset(task.workflowPreset, task.presetVersion)
  const validation = validateTransition({
    task: { ...task, roleMap },
    preset,
    actor: {
      agentId: actor?.agentId ?? '',
      role: actor?.role ?? '',
    },
    toPhase: parsed.toPhase,
    evidence: selectedEvidence,
    expectedVersion: parsed.expectedVersion,
    ...(parsed.waivers !== undefined ? { waivers: parsed.waivers } : {}),
  })

  if (!validation.ok) {
    unprocessable(validation.error.code, validation.error.message, {
      fromPhase: validation.error.fromPhase,
      toPhase: validation.error.toPhase,
      ...(validation.error.missingEvidenceKinds !== undefined
        ? { missingEvidenceKinds: [...validation.error.missingEvidenceKinds] }
        : {}),
    })
  }

  const timestamp = new Date().toISOString()
  const loggedTransition: LoggedTransitionRecord = {
    taskId,
    transitionEventId: `tte_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    timestamp,
    ...validation.transition.record,
  }
  const updatedTask = applyTransitionDecision({ ...task, roleMap }, validation.transition)
  const committedTask = deps.wrkqStore.runInTransaction((store) => {
    const persisted = store.taskRepo.updateTask({ ...updatedTask, roleMap, version: task.version })
    store.transitionLogRepo.appendTransition(taskId, loggedTransition)
    return persisted
  })

  const shouldHandoff = shouldDeclareTesterHandoff({
    fromPhase: task.phase,
    toPhase: parsed.toPhase,
    roleMap,
    riskClass: task.riskClass,
    requestHandoff: parsed.requestHandoff,
  })

  const handoffResult = shouldHandoff
    ? appendTesterHandoffOnTransition({
        coordStore: deps.coordStore,
        projectId: task.projectId,
        taskId,
        fromPhase: task.phase,
        toPhase: parsed.toPhase,
        actor: { agentId: actor?.agentId ?? '', role: actor?.role ?? '' },
        roleMap,
        ...(parsed.idempotencyKey !== undefined ? { idempotencyKey: parsed.idempotencyKey } : {}),
      })
    : undefined

  return json({
    task: committedTask,
    transition: loggedTransition,
    ...(handoffResult?.handoff !== undefined ? { handoff: handoffResult.handoff } : {}),
    ...(handoffResult?.wake !== undefined ? { wake: handoffResult.wake } : {}),
  })
}
