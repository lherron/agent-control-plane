import { createInMemoryAdminStore } from 'acp-admin-store'

import {
  type AcpServerDeps,
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
} from '../../src/index.js'

export type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

export function createAdmissionStores() {
  return {
    adminStore: createInMemoryAdminStore(),
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputApplicationStore: new InMemoryInputApplicationStore(),
    inputQueueStore: new InMemoryInputQueueStore(),
    sessionAdmissionSequenceStore: new InMemorySessionAdmissionSequenceStore(),
  }
}

export function admissionRuntime(agent = 'larry') {
  return {
    agentRoot: `/tmp/agents/${agent}`,
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
    harness: { provider: 'openai' as const, interactive: true },
  }
}
