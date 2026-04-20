import type { RiskClass } from './task.js'

export interface PhaseGuidance {
  objective: string
  doneWhen: readonly string[]
  suggestedEvidence: readonly string[]
  agentHints: readonly string[]
}

export interface TransitionPolicyRule {
  fromPhase: string
  toPhase: string
  allowedRoles: readonly string[]
  disallowSameAgentAsRoles: readonly string[]
  requiredEvidenceKinds: readonly string[]
  waiverKinds?: readonly string[] | undefined
  riskClasses?: readonly RiskClass[] | undefined
}

export interface Preset {
  presetId: string
  version: number
  kind: string
  phaseGraph: readonly string[]
  defaultRoles: readonly string[]
  transitionPolicy: readonly TransitionPolicyRule[]
  guidance: Readonly<Record<string, PhaseGuidance>>
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

function deepFreezeValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    return
  }

  if (seen.has(value)) {
    return
  }

  seen.add(value)

  for (const nestedValue of Object.values(value)) {
    deepFreezeValue(nestedValue, seen)
  }

  Object.freeze(value)
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  deepFreezeValue(value, new WeakSet<object>())
  return value as DeepReadonly<T>
}

export function matchesRiskClass(
  rule: TransitionPolicyRule,
  riskClass: RiskClass | undefined
): boolean {
  if (rule.riskClasses === undefined) {
    return true
  }

  if (riskClass === undefined) {
    return false
  }

  return rule.riskClasses.includes(riskClass)
}

export function findTransitionPolicyRule(
  preset: Preset,
  fromPhase: string,
  toPhase: string,
  riskClass: RiskClass | undefined
): TransitionPolicyRule | undefined {
  return preset.transitionPolicy.find(
    (rule) =>
      rule.fromPhase === fromPhase && rule.toPhase === toPhase && matchesRiskClass(rule, riskClass)
  )
}

export function listOutboundTransitionRules(
  preset: Preset,
  phase: string,
  riskClass: RiskClass | undefined
): TransitionPolicyRule[] {
  return preset.transitionPolicy.filter(
    (rule) => rule.fromPhase === phase && matchesRiskClass(rule, riskClass)
  )
}
