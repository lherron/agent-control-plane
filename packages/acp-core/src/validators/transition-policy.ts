import {
  findMissingEvidenceKinds,
  getWaiverDetails,
  listEvidenceKinds,
} from '../models/evidence.js'
import type { EvidenceItem } from '../models/evidence.js'
import { findTransitionPolicyRule } from '../models/preset.js'
import type { Preset, TransitionPolicyRule } from '../models/preset.js'
import { getRoleAgentId } from '../models/role-map.js'
import { deriveLifecycleStateAfterTransition, toTaskStateRef } from '../models/task.js'
import type { Task } from '../models/task.js'
import { normalizeTransitionActor } from '../models/transition.js'
import type {
  TransitionDecision,
  TransitionRejection,
  TransitionResult,
} from '../models/transition.js'

function reject(error: TransitionRejection): TransitionResult {
  return { ok: false, error }
}

function isWaiverValidForMissingEvidence(input: {
  waivers: readonly EvidenceItem[]
  requiredEvidenceKind: string
  fromPhase: string
  toPhase: string
  rule: TransitionPolicyRule
}): boolean {
  const transitionScope = `${input.fromPhase}->${input.toPhase}`

  return input.waivers.some((waiver) => {
    const details = getWaiverDetails(waiver)
    if (details?.waiverKind === undefined) {
      return false
    }

    const scopeMatches =
      details.scope === undefined ||
      details.scope === input.requiredEvidenceKind ||
      details.scope === transitionScope
    const waiverKindMatches =
      details.waiverKind === input.requiredEvidenceKind ||
      input.rule.waiverKinds?.includes(details.waiverKind) === true

    if (!scopeMatches || !waiverKindMatches) {
      return false
    }

    if (details.expiresAt === undefined) {
      return true
    }

    const expiresAt = Date.parse(details.expiresAt)
    if (Number.isNaN(expiresAt)) {
      return false
    }

    return expiresAt >= Date.now()
  })
}

export function validateTransition(input: {
  task: Task
  preset: Preset
  actor: { agentId: string; role: string; scopeRef?: string | undefined }
  toPhase: string
  evidence: readonly EvidenceItem[]
  expectedVersion: number
  waivers?: readonly EvidenceItem[] | undefined
}): { ok: true; transition: TransitionDecision } | { ok: false; error: TransitionRejection } {
  const taskRoleMap = input.task.roleMap
  const actor = normalizeTransitionActor(input.actor)
  const rule = findTransitionPolicyRule(
    input.preset,
    input.task.phase,
    input.toPhase,
    input.task.riskClass
  )

  if (rule === undefined) {
    return reject({
      code: 'unknown_transition',
      message: `No transition rule matches ${input.task.phase} -> ${input.toPhase}`,
      fromPhase: input.task.phase,
      toPhase: input.toPhase,
    })
  }

  if (!rule.allowedRoles.includes(actor.role)) {
    return reject({
      code: 'role_not_allowed',
      message: `Role "${actor.role}" is not allowed for ${input.task.phase} -> ${input.toPhase}`,
      fromPhase: input.task.phase,
      toPhase: input.toPhase,
    })
  }

  const conflictingRole = rule.disallowSameAgentAsRoles.find(
    (role) => getRoleAgentId(taskRoleMap, role) === actor.agentId
  )
  if (conflictingRole !== undefined) {
    return reject({
      code: 'sod_violation',
      message: `Actor "${actor.agentId}" conflicts with role "${conflictingRole}" for ${input.task.phase} -> ${input.toPhase}`,
      fromPhase: input.task.phase,
      toPhase: input.toPhase,
    })
  }

  const missingEvidenceKinds = findMissingEvidenceKinds(input.evidence, rule.requiredEvidenceKinds)
  if (missingEvidenceKinds.length > 0) {
    const waivers = input.waivers ?? []
    if (waivers.length === 0) {
      return reject({
        code: 'missing_evidence',
        message: `Missing required evidence for ${input.task.phase} -> ${input.toPhase}`,
        fromPhase: input.task.phase,
        toPhase: input.toPhase,
        missingEvidenceKinds,
      })
    }

    const stillMissingEvidenceKinds = missingEvidenceKinds.filter(
      (requiredEvidenceKind) =>
        !isWaiverValidForMissingEvidence({
          waivers,
          requiredEvidenceKind,
          fromPhase: input.task.phase,
          toPhase: input.toPhase,
          rule,
        })
    )

    if (stillMissingEvidenceKinds.length > 0) {
      return reject({
        code: 'no_waiver',
        message: `No valid waiver covers ${input.task.phase} -> ${input.toPhase}`,
        fromPhase: input.task.phase,
        toPhase: input.toPhase,
        missingEvidenceKinds: stillMissingEvidenceKinds,
      })
    }
  }

  if (input.expectedVersion !== input.task.version) {
    return reject({
      code: 'version_conflict',
      message: `Task version ${input.task.version} does not match expectedVersion ${input.expectedVersion}`,
      fromPhase: input.task.phase,
      toPhase: input.toPhase,
    })
  }

  const lifecycleState = deriveLifecycleStateAfterTransition(input.task, input.toPhase)
  const waivedEvidenceKinds = missingEvidenceKinds.filter((requiredEvidenceKind) =>
    isWaiverValidForMissingEvidence({
      waivers: input.waivers ?? [],
      requiredEvidenceKind,
      fromPhase: input.task.phase,
      toPhase: input.toPhase,
      rule,
    })
  )

  return {
    ok: true,
    transition: {
      phase: input.toPhase,
      lifecycleState,
      version: input.task.version + 1,
      record: {
        from: toTaskStateRef(input.task),
        to: {
          lifecycleState,
          phase: input.toPhase,
        },
        actor,
        requiredEvidenceKinds: [...rule.requiredEvidenceKinds],
        evidenceKinds: listEvidenceKinds(input.evidence),
        waivedEvidenceKinds,
        expectedVersion: input.expectedVersion,
        nextVersion: input.task.version + 1,
      },
    },
  }
}
