import type { ActorRef, WorkState, WorkflowRejection, WorkflowRejectionCode } from './types.js'

export const VALID_STATUSES = new Set<string>(['open', 'active', 'waiting', 'closed'])

export function reject(
  code: WorkflowRejectionCode,
  message: string,
  extra: Partial<WorkflowRejection> = {}
): { ok: false; error: WorkflowRejection } {
  return { ok: false, error: { code, message, ...extra } }
}

export function actorEquals(left: ActorRef | null | undefined, right: ActorRef): boolean {
  return left?.kind === right.kind && left.id === right.id
}

export function validateWorkState(state: WorkState): WorkflowRejection | undefined {
  if (!VALID_STATUSES.has(state.status)) {
    return {
      code: 'invalid_work_state',
      message: `Invalid workflow status "${state.status}"`,
    }
  }
  if (state.status !== 'closed' && state.outcome !== undefined && state.outcome !== null) {
    return {
      code: 'invalid_work_state',
      message: 'Only closed work states may carry an outcome',
    }
  }
  return undefined
}

export function stateMatches(state: WorkState, pattern: Partial<WorkState>): boolean {
  if (pattern.status !== undefined && state.status !== pattern.status) {
    return false
  }
  if (pattern.phase !== undefined && (state.phase ?? null) !== (pattern.phase ?? null)) {
    return false
  }
  if (pattern.outcome !== undefined && (state.outcome ?? null) !== (pattern.outcome ?? null)) {
    return false
  }
  return true
}

export function applyStatePatch(state: WorkState, patch: Partial<WorkState>): WorkState {
  const next: WorkState = {
    status: patch.status ?? state.status,
    phase: patch.phase !== undefined ? patch.phase : state.phase,
  }
  if (patch.outcome !== undefined) {
    next.outcome = patch.outcome
  } else if (next.status === 'closed' && state.outcome !== undefined) {
    next.outcome = state.outcome
  }
  if (next.status !== 'closed') {
    next.outcome = undefined
  }
  return next
}
