export {
  applyTransitionDecision,
  deriveLifecycleStateAfterTransition,
  isPresetDrivenTask,
  toTaskStateRef,
} from './models/task.js'
export type { RiskClass, Task, TaskLifecycleState, TaskStateRef } from './models/task.js'

export {
  findMissingEvidenceKinds,
  getWaiverDetails,
  hasEvidenceKind,
  isWaiverEvidence,
  listEvidenceKinds,
} from './models/evidence.js'
export type {
  EvidenceBuild,
  EvidenceDetails,
  EvidenceItem,
  EvidenceProducer,
} from './models/evidence.js'

export {
  getRoleAgentId,
  hasRoleAssignment,
  listAssignedRoles,
} from './models/role-map.js'
export type { RoleMap } from './models/role-map.js'

export {
  deepFreeze,
  findTransitionPolicyRule,
  listOutboundTransitionRules,
  matchesRiskClass,
} from './models/preset.js'
export type { DeepReadonly, PhaseGuidance, Preset, TransitionPolicyRule } from './models/preset.js'

export { normalizeTransitionActor } from './models/transition.js'
export type {
  LoggedTransitionRecord,
  TransitionActor,
  TransitionDecision,
  TransitionRecord,
  TransitionRejection,
  TransitionRejectionCode,
  TransitionRequest,
  TransitionResult,
} from './models/transition.js'

export type { InputAttempt } from './models/input-attempt.js'
export type { Run } from './models/run.js'
export type { Session } from './models/session.js'

export { codeDefectFastlaneV1 } from './presets/code_defect_fastlane.v1.js'
export { getPreset, listPresets } from './presets/registry.js'
export { validateTransition } from './validators/transition-policy.js'
export { computeTaskContext } from './task-context.js'

export type {
  EvidenceStore,
  RoleAssignmentStore,
  TaskStore,
  TransitionLogStore,
} from './store/task-store.js'
