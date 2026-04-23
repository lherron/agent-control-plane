import type { RoleMap } from './role-map.js'

export type TaskLifecycleState =
  | 'open'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | (string & {})
export type RiskClass = 'low' | 'medium' | 'high' | (string & {})

export interface Task {
  taskId: string
  projectId: string
  kind: string
  workflowPreset?: string | undefined
  presetVersion?: number | undefined
  lifecycleState: TaskLifecycleState
  phase: string | null
  riskClass?: RiskClass | undefined
  roleMap: RoleMap
  version: number
  meta?: Readonly<Record<string, unknown>> | undefined
}

export interface TaskStateRef {
  lifecycleState: TaskLifecycleState
  phase: string | null
}

export function isPresetDrivenTask(task: Task): boolean {
  return task.workflowPreset !== undefined && task.presetVersion !== undefined
}

export function toTaskStateRef(task: Task): TaskStateRef {
  return {
    lifecycleState: task.lifecycleState,
    phase: task.phase,
  }
}

export function isLifecycleTarget(toPhase: string): boolean {
  return toPhase === 'completed' || toPhase === 'active'
}

export function deriveLifecycleStateAfterTransition(
  task: Task,
  toPhase: string
): TaskLifecycleState {
  if (isLifecycleTarget(toPhase)) {
    return toPhase as TaskLifecycleState
  }

  // Entering any real phase while still 'open' activates the task
  if (task.lifecycleState === 'open') {
    return 'active'
  }

  return task.lifecycleState
}

export function applyTransitionDecision(
  task: Task,
  decision: { phase: string | null; lifecycleState: TaskLifecycleState; version: number }
): Task {
  return {
    ...task,
    phase: decision.phase,
    lifecycleState: decision.lifecycleState,
    version: decision.version,
  }
}
