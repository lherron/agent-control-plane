import {
  findMissingEvidenceKinds,
  getWaiverDetails,
  listEvidenceKinds,
} from '../models/evidence.js'
import type { EvidenceItem } from '../models/evidence.js'
import { matchesRiskClass } from '../models/preset.js'
import type { Preset, TransitionPolicyRule } from '../models/preset.js'
import { getRoleAgentId } from '../models/role-map.js'
import {
  deriveLifecycleStateAfterTransition,
  isLifecycleTarget,
  toTaskStateRef,
} from '../models/task.js'
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

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values))
}

function isWaiverValidForMissingEvidence(input: {
  waivers: readonly EvidenceItem[]
  requiredEvidenceKind: string
  fromPhase: string | null
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
  const currentPhase = input.task.phase ?? ''
  const matchingRules = input.preset.transitionPolicy.filter(
    (rule) =>
      rule.fromPhase === currentPhase &&
      rule.toPhase === input.toPhase &&
      matchesRiskClass(rule, input.task.riskClass)
  )

  if (matchingRules.length === 0) {
    return reject({
      code: 'unknown_transition',
      message: `No transition rule matches ${currentPhase} -> ${input.toPhase}`,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
    })
  }

  const roleAllowedRules = matchingRules.filter((rule) => rule.allowedRoles.includes(actor.role))
  if (roleAllowedRules.length === 0) {
    return reject({
      code: 'role_not_allowed',
      message: `Role "${actor.role}" is not allowed for ${currentPhase} -> ${input.toPhase}`,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
    })
  }

  const rulesWithoutSodViolation = roleAllowedRules.filter(
    (rule) =>
      rule.disallowSameAgentAsRoles.find(
        (role) => getRoleAgentId(taskRoleMap, role) === actor.agentId
      ) === undefined
  )
  if (rulesWithoutSodViolation.length === 0) {
    const conflictingRole = roleAllowedRules
      .flatMap((rule) => [...rule.disallowSameAgentAsRoles])
      .find((role) => getRoleAgentId(taskRoleMap, role) === actor.agentId)
    return reject({
      code: 'sod_violation',
      message: `Actor "${actor.agentId}" conflicts with role "${conflictingRole}" for ${currentPhase} -> ${input.toPhase}`,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
    })
  }

  const rulesWithMissingEvidence = rulesWithoutSodViolation.map((rule) => ({
    rule,
    missingEvidenceKinds: findMissingEvidenceKinds(input.evidence, rule.requiredEvidenceKinds),
  }))
  const satisfiedRule = rulesWithMissingEvidence.find(
    ({ missingEvidenceKinds }) => missingEvidenceKinds.length === 0
  )
  const waivers = input.waivers ?? []
  const waivedRule =
    satisfiedRule ??
    rulesWithMissingEvidence.find(({ rule, missingEvidenceKinds }) =>
      missingEvidenceKinds.every((requiredEvidenceKind) =>
        isWaiverValidForMissingEvidence({
          waivers,
          requiredEvidenceKind,
          fromPhase: currentPhase,
          toPhase: input.toPhase,
          rule,
        })
      )
    )

  if (waivedRule === undefined) {
    const missingEvidenceKinds = dedupe(
      rulesWithMissingEvidence.flatMap((entry) => entry.missingEvidenceKinds)
    )
    if (waivers.length === 0) {
      return reject({
        code: 'missing_evidence',
        message: `Missing required evidence for ${currentPhase} -> ${input.toPhase}`,
        fromPhase: currentPhase,
        toPhase: input.toPhase,
        missingEvidenceKinds,
      })
    }

    return reject({
      code: 'no_waiver',
      message: `No valid waiver covers ${currentPhase} -> ${input.toPhase}`,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
      missingEvidenceKinds,
    })
  }
  const rule = waivedRule.rule
  const missingEvidenceKinds = waivedRule.missingEvidenceKinds

  if (input.expectedVersion !== input.task.version) {
    return reject({
      code: 'version_conflict',
      message: `Task version ${input.task.version} does not match expectedVersion ${input.expectedVersion}`,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
    })
  }

  const lifecycleState = deriveLifecycleStateAfterTransition(input.task, input.toPhase)
  const waivedEvidenceKinds = missingEvidenceKinds.filter((requiredEvidenceKind) =>
    isWaiverValidForMissingEvidence({
      waivers: input.waivers ?? [],
      requiredEvidenceKind,
      fromPhase: currentPhase,
      toPhase: input.toPhase,
      rule,
    })
  )

  // For lifecycle-only transitions (e.g. verified -> completed), phase stays unchanged
  const resultPhase = isLifecycleTarget(input.toPhase) ? input.task.phase : input.toPhase

  return {
    ok: true,
    transition: {
      phase: resultPhase,
      lifecycleState,
      version: input.task.version + 1,
      record: {
        from: toTaskStateRef(input.task),
        to: {
          lifecycleState,
          phase: resultPhase,
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
