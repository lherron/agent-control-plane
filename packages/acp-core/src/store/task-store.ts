import type { EvidenceItem } from '../models/evidence.js'
import type { RoleMap } from '../models/role-map.js'
import type { Task } from '../models/task.js'
import type { LoggedTransitionRecord } from '../models/transition.js'

// External store ports are async (Promise-returning): they are backed by an
// out-of-process wrkq/wrkf authority reached over @wrkq/client RPC. The
// in-memory workflow kernel stays synchronous — only these four external
// store ports cross the async boundary.
export interface TaskStore {
  createTask(task: Task): Promise<Task>
  getTask(taskId: string): Promise<Task | undefined>
  updateTask(task: Task): Promise<Task>
}

export interface EvidenceStore {
  listEvidence(taskId: string): Promise<readonly EvidenceItem[]>
  appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): Promise<void>
}

export interface RoleAssignmentStore {
  getRoleMap(taskId: string): Promise<RoleMap | undefined>
  setRoleMap(taskId: string, roleMap: RoleMap): Promise<void>
}

export interface TransitionLogStore {
  listTransitions(taskId: string): Promise<readonly LoggedTransitionRecord[]>
  appendTransition(taskId: string, transition: LoggedTransitionRecord): Promise<void>
}
