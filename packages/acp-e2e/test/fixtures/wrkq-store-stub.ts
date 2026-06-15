import type {
  EvidenceItem,
  EvidenceStore,
  LoggedTransitionRecord,
  RoleAssignmentStore,
  RoleMap,
  Task,
  TaskStore,
  TransitionLogStore,
} from 'acp-core'

/**
 * Local in-memory stand-in for the `WrkqStoreAdapter` shape (wrkq-lib) used by
 * the acp-e2e stack after the SQLite store layer was removed (epic T-04763
 * Phase 2d). Implemented against the acp-core package's exported store-port
 * types so the composite acp-e2e tsconfig does NOT pull acp-core source files
 * into its program. The e2e suites only consume {@link WRKQ_TEST_SEED} project
 * identifiers — never live wrkq rows — so a trivial Map-backed store suffices.
 */
export interface StubWrkqStoreAdapter {
  readonly taskStore: TaskStore
  readonly evidenceStore: EvidenceStore
  readonly roleAssignmentStore: RoleAssignmentStore
  readonly transitionLogStore: TransitionLogStore
}

class InMemoryStubStore
  implements TaskStore, EvidenceStore, RoleAssignmentStore, TransitionLogStore
{
  private readonly tasks = new Map<string, Task>()
  private readonly evidence = new Map<string, EvidenceItem[]>()
  private readonly roleMaps = new Map<string, RoleMap>()
  private readonly transitions = new Map<string, LoggedTransitionRecord[]>()

  async createTask(task: Task): Promise<Task> {
    this.tasks.set(task.taskId, task)
    this.roleMaps.set(task.taskId, { ...task.roleMap })
    return task
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId)
  }

  async updateTask(task: Task): Promise<Task> {
    this.tasks.set(task.taskId, task)
    return task
  }

  async listEvidence(taskId: string): Promise<readonly EvidenceItem[]> {
    return this.evidence.get(taskId) ?? []
  }

  async appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): Promise<void> {
    this.evidence.set(taskId, [...(this.evidence.get(taskId) ?? []), ...evidence])
  }

  async getRoleMap(taskId: string): Promise<RoleMap | undefined> {
    return this.roleMaps.get(taskId)
  }

  async setRoleMap(taskId: string, roleMap: RoleMap): Promise<void> {
    this.roleMaps.set(taskId, { ...roleMap })
  }

  async listTransitions(taskId: string): Promise<readonly LoggedTransitionRecord[]> {
    return this.transitions.get(taskId) ?? []
  }

  async appendTransition(taskId: string, transition: LoggedTransitionRecord): Promise<void> {
    this.transitions.set(taskId, [...(this.transitions.get(taskId) ?? []), transition])
  }
}

export function createStubWrkqStoreAdapter(): StubWrkqStoreAdapter {
  const store = new InMemoryStubStore()
  return {
    taskStore: store,
    evidenceStore: store,
    roleAssignmentStore: store,
    transitionLogStore: store,
  }
}

/**
 * Static project metadata previously derived from the deleted seed-wrkq-db
 * SQLite fixture. The e2e suites only use the project id/slug constants.
 */
export const WRKQ_TEST_SEED = {
  bootstrapActorUuid: '00000000-0000-4000-8000-0000000000b0',
  rootContainerUuid: '00000000-0000-4000-8000-000000000001',
  projectUuid: '00000000-0000-4000-8000-000000000101',
  projectId: 'P-00001',
  projectSlug: 'demo',
  secondaryProjectUuid: '00000000-0000-4000-8000-000000000102',
  secondaryProjectId: 'P-00002',
  secondaryProjectSlug: 'demo-two',
} as const
