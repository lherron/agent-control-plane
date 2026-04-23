import { applyTransitionDecision } from '../../src/models/task.js'
import { getPreset } from '../../src/presets/registry.js'
import { validateTransition } from '../../src/validators/transition-policy.js'

import type { EvidenceItem } from '../../src/models/evidence.js'
import type { RoleMap } from '../../src/models/role-map.js'
import type { Task } from '../../src/models/task.js'
import type { LoggedTransitionRecord, TransitionActor } from '../../src/models/transition.js'
import type {
  EvidenceStore,
  RoleAssignmentStore,
  TaskStore,
  TransitionLogStore,
} from '../../src/store/task-store.js'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: overrides.taskId ?? 'task-001',
    projectId: overrides.projectId ?? 'demo',
    kind: overrides.kind ?? 'code_change',
    workflowPreset: overrides.workflowPreset ?? 'code_defect_fastlane',
    presetVersion: overrides.presetVersion ?? 1,
    lifecycleState: overrides.lifecycleState ?? 'active',
    phase: overrides.phase !== undefined ? overrides.phase : 'red',
    riskClass: overrides.riskClass ?? 'medium',
    roleMap:
      overrides.roleMap ??
      ({
        triager: 'tracy',
        implementer: 'larry',
        tester: 'curly',
        owner: 'olivia',
      } satisfies RoleMap),
    version: overrides.version ?? 0,
    ...(overrides.meta ? { meta: overrides.meta } : {}),
  }
}

export function createEvidence(kind: string, ref = `artifact://${kind}`): EvidenceItem {
  return { kind, ref }
}

export function createWaiver(input: {
  waiverKind: string
  scope: string
  expiresAt?: string | undefined
}): EvidenceItem {
  return {
    kind: 'waiver',
    ref: `artifact://waivers/${input.waiverKind}`,
    details: {
      waiverKind: input.waiverKind,
      scope: input.scope,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  }
}

type StoreResult<T> =
  | { task: T; transitionEventId?: string | undefined }
  | {
      error: { code: string; message: string; missingEvidenceKinds?: readonly string[] | undefined }
    }

export class InMemoryAcpWorkflowStore
  implements TaskStore, EvidenceStore, RoleAssignmentStore, TransitionLogStore
{
  private readonly tasks = new Map<string, Task>()
  private readonly evidence = new Map<string, EvidenceItem[]>()
  private readonly roleMaps = new Map<string, RoleMap>()
  private readonly transitions = new Map<string, LoggedTransitionRecord[]>()
  private transitionSequence = 0

  createTask(task: Task): Task {
    const storedTask = clone(task)
    this.tasks.set(task.taskId, storedTask)
    this.evidence.set(task.taskId, [])
    this.roleMaps.set(task.taskId, clone(task.roleMap))
    this.transitions.set(task.taskId, [])
    return clone(storedTask)
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId)
    return task === undefined ? undefined : clone(task)
  }

  updateTask(task: Task): Task {
    const storedTask = clone(task)
    this.tasks.set(task.taskId, storedTask)
    return clone(storedTask)
  }

  listEvidence(taskId: string): readonly EvidenceItem[] {
    return clone(this.evidence.get(taskId) ?? [])
  }

  appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): void {
    this.evidence.set(taskId, [...(this.evidence.get(taskId) ?? []), ...clone(evidence)])
  }

  getRoleMap(taskId: string): RoleMap | undefined {
    const roleMap = this.roleMaps.get(taskId)
    return roleMap === undefined ? undefined : clone(roleMap)
  }

  setRoleMap(taskId: string, roleMap: RoleMap): void {
    this.roleMaps.set(taskId, clone(roleMap))
  }

  listTransitions(taskId: string): readonly LoggedTransitionRecord[] {
    return clone(this.transitions.get(taskId) ?? [])
  }

  appendTransition(taskId: string, transition: LoggedTransitionRecord): void {
    this.transitions.set(taskId, [...(this.transitions.get(taskId) ?? []), clone(transition)])
  }

  transition(
    taskId: string,
    input: {
      toPhase: string
      actor: TransitionActor
      evidence: readonly EvidenceItem[]
      expectedVersion: number
      waivers?: readonly EvidenceItem[] | undefined
    }
  ): StoreResult<Task> {
    const task = this.tasks.get(taskId)
    if (task === undefined) {
      return { error: { code: 'NOT_FOUND', message: `Task not found: ${taskId}` } }
    }

    if (task.workflowPreset === undefined || task.presetVersion === undefined) {
      throw new Error(`Task ${taskId} is not pinned to a workflow preset`)
    }

    const preset = getPreset(task.workflowPreset, task.presetVersion)
    const roleMap = this.roleMaps.get(taskId) ?? task.roleMap
    const combinedEvidence = [...(this.evidence.get(taskId) ?? []), ...input.evidence]
    const waivers = input.waivers ?? input.evidence.filter((item) => item.kind === 'waiver')
    const validation = validateTransition({
      task: { ...task, roleMap },
      preset,
      actor: input.actor,
      toPhase: input.toPhase,
      evidence: combinedEvidence,
      expectedVersion: input.expectedVersion,
      waivers,
    })

    if (!validation.ok) {
      return { error: clone(validation.error) }
    }

    this.appendEvidence(taskId, input.evidence)
    const updatedTask = applyTransitionDecision({ ...task, roleMap }, validation.transition)
    this.tasks.set(taskId, clone(updatedTask))

    const transitionEventId = `tte_${String(++this.transitionSequence).padStart(4, '0')}`
    const loggedTransition: LoggedTransitionRecord = {
      taskId,
      transitionEventId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, this.transitionSequence)).toISOString(),
      ...validation.transition.record,
    }
    this.appendTransition(taskId, loggedTransition)

    return { task: clone(updatedTask), transitionEventId }
  }

  getTransitions(
    taskId: string
  ): { transitions: LoggedTransitionRecord[] } | { error: { code: 'NOT_FOUND'; message: string } } {
    if (!this.tasks.has(taskId)) {
      return { error: { code: 'NOT_FOUND', message: `Task not found: ${taskId}` } }
    }

    return { transitions: clone(this.transitions.get(taskId) ?? []) }
  }
}
