import type { EvidenceItem } from '../models/evidence.js'
import type { RoleMap } from '../models/role-map.js'
import type { Task } from '../models/task.js'
import type { LoggedTransitionRecord } from '../models/transition.js'

export interface TaskStore {
  createTask(task: Task): Task
  getTask(taskId: string): Task | undefined
  updateTask(task: Task): Task
}

export interface EvidenceStore {
  listEvidence(taskId: string): readonly EvidenceItem[]
  appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): void
}

export interface RoleAssignmentStore {
  getRoleMap(taskId: string): RoleMap | undefined
  setRoleMap(taskId: string, roleMap: RoleMap): void
}

export interface TransitionLogStore {
  listTransitions(taskId: string): readonly LoggedTransitionRecord[]
  appendTransition(taskId: string, transition: LoggedTransitionRecord): void
}
