import { randomUUID } from 'node:crypto'

import { type LoggedTransitionRecord, applyTransitionDecision, validateTransition } from 'acp-core'
import { appendEvent } from 'coordination-substrate'

import { json, unprocessable } from '../http.js'
import {
  buildTesterHandoffAppendEventCommand,
  buildTesterTransitionOutboxPayload,
  shouldDeclareTesterHandoff,
} from '../integration/handoff-on-transition.js'
import { reconcileTransitionOutbox } from '../integration/transition-outbox-reconciler.js'
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
    ? (() => {
        const payload = buildTesterTransitionOutboxPayload({
          transitionTimestamp: timestamp,
          actor: { agentId: actor?.agentId ?? '', role: actor?.role ?? '' },
          roleMap,
        })

        if (deps.stateStore === undefined) {
          return appendEvent(
            deps.coordStore,
            buildTesterHandoffAppendEventCommand({
              projectId: task.projectId,
              taskId,
              fromPhase: task.phase,
              toPhase: parsed.toPhase,
              payload,
              idempotencyKey: loggedTransition.transitionEventId,
            })
          )
        }

        deps.stateStore.transitionOutbox.append({
          transitionEventId: loggedTransition.transitionEventId,
          taskId,
          projectId: task.projectId,
          fromPhase: task.phase,
          toPhase: parsed.toPhase,
          actor:
            actor?.agentId !== undefined && actor.agentId.length > 0
              ? { kind: 'agent', id: actor.agentId }
              : deps.defaultActor,
          payload,
        })

        return reconcileTransitionOutbox({
          wrkqStore: deps.wrkqStore,
          stateStore: deps.stateStore,
          coordStore: deps.coordStore,
        }).then(
          (result) =>
            result.delivered.find(
              (delivery) => delivery.transitionEventId === loggedTransition.transitionEventId
            )?.result
        )
      })()
    : undefined

  const resolvedHandoffResult =
    handoffResult instanceof Promise ? await handoffResult : handoffResult

  return json({
    task: committedTask,
    transition: loggedTransition,
    ...(resolvedHandoffResult?.handoff !== undefined
      ? { handoff: resolvedHandoffResult.handoff }
      : {}),
    ...(resolvedHandoffResult?.wake !== undefined ? { wake: resolvedHandoffResult.wake } : {}),
  })
}
