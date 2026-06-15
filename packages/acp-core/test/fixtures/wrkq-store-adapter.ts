import { InMemoryAcpWorkflowStore } from './in-memory-stores.js'

import type {
  EvidenceStore,
  RoleAssignmentStore,
  TaskStore,
  TransitionLogStore,
} from '../../src/store/task-store.js'

/**
 * In-memory stand-in for the `WrkqStoreAdapter` shape (wrkq-lib) used across the
 * acp-server / acp-cli / acp-e2e test fixtures after the SQLite store layer was
 * removed (epic T-04763 Phase 2d). A single {@link InMemoryAcpWorkflowStore}
 * backs all four acp-core store ports, so created tasks round-trip faithfully
 * (preset/phase/roleMap preserved) — which the real @wrkq/client adapter does
 * NOT do (phase/preset live in the wrkf instance). Tests that need a live
 * task/role round-trip use this; the real adapter is covered by the wrkq-lib
 * parity suite against the real binary.
 */
export interface InMemoryWrkqStoreAdapter {
  readonly taskStore: TaskStore
  readonly evidenceStore: EvidenceStore
  readonly roleAssignmentStore: RoleAssignmentStore
  readonly transitionLogStore: TransitionLogStore
}

export function createInMemoryWrkqStoreAdapter(): InMemoryWrkqStoreAdapter {
  const store = new InMemoryAcpWorkflowStore()
  return {
    taskStore: store,
    evidenceStore: store,
    roleAssignmentStore: store,
    transitionLogStore: store,
  }
}

/**
 * Static project metadata that the deleted `seed-wrkq-db` fixture used to derive
 * from a freshly migrated SQLite DB. The downstream tests only consume these
 * identifier constants (project ids/slugs) to build scope refs — never live
 * wrkq rows — so plain constants are sufficient.
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
