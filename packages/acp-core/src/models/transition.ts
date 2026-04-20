import { parseScopeRef } from 'agent-scope'

import type { EvidenceItem } from './evidence.js'
import type { Task, TaskStateRef } from './task.js'

export interface TransitionActor {
  agentId: string
  role: string
  scopeRef?: string | undefined
}

export interface TransitionRecord {
  from: TaskStateRef
  to: TaskStateRef
  actor: TransitionActor
  requiredEvidenceKinds: readonly string[]
  evidenceKinds: readonly string[]
  waivedEvidenceKinds: readonly string[]
  expectedVersion: number
  nextVersion: number
}

export interface LoggedTransitionRecord extends TransitionRecord {
  taskId: string
  transitionEventId: string
  timestamp: string
}

export interface TransitionDecision {
  phase: string
  lifecycleState: Task['lifecycleState']
  version: number
  record: TransitionRecord
}

export type TransitionRejectionCode =
  | 'unknown_transition'
  | 'role_not_allowed'
  | 'sod_violation'
  | 'missing_evidence'
  | 'no_waiver'
  | 'version_conflict'

export interface TransitionRejection {
  code: TransitionRejectionCode
  message: string
  fromPhase: string
  toPhase: string
  missingEvidenceKinds?: readonly string[] | undefined
}

export interface TransitionRequest {
  task: Task
  actor: TransitionActor
  toPhase: string
  evidence: readonly EvidenceItem[]
  expectedVersion: number
  waivers?: readonly EvidenceItem[] | undefined
}

export type TransitionResult =
  | { ok: true; transition: TransitionDecision }
  | { ok: false; error: TransitionRejection }

export function normalizeTransitionActor(actor: TransitionActor): TransitionActor {
  if (actor.scopeRef === undefined) {
    return actor
  }

  const parsedScopeRef = parseScopeRef(actor.scopeRef)
  if (parsedScopeRef.agentId !== actor.agentId) {
    throw new Error(
      `Actor agentId "${actor.agentId}" does not match scopeRef agentId "${parsedScopeRef.agentId}"`
    )
  }

  if (parsedScopeRef.roleName !== undefined && parsedScopeRef.roleName !== actor.role) {
    throw new Error(
      `Actor role "${actor.role}" does not match scopeRef role "${parsedScopeRef.roleName}"`
    )
  }

  return actor
}
