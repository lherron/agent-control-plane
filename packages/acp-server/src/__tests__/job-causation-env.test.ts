import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { HrcRuntimeIntent } from 'hrc-core'

import type { LaunchRoleScopedRun, ResolvedAcpServerDeps, RuntimeResolver } from '../deps.js'
import {
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
} from '../domain/input-admission-stores.js'
import { InMemoryInputAttemptStore } from '../domain/input-attempt-store.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import { dispatchJobRunThroughInputs } from '../handlers/admin-jobs.js'
import { createInputQueueDispatcher } from '../integration/input-queue-dispatcher.js'
import { WRKQ_CAUSATION_REF_ENV, causationLaunchEnvFromRunMetadata } from '../jobs/causation-env.js'

const SESSION_REF = {
  scopeRef: 'agent:clod:project:agent-spaces:task:T-05993',
  laneRef: 'main',
}

const RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/clod',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

function inertInterfaceStore() {
  return {
    bindings: {
      list: () => [],
      getById: () => undefined,
    },
  }
}

function makeDeps(captured: HrcRuntimeIntent[] = []): ResolvedAcpServerDeps {
  const runStore = new InMemoryRunStore()
  const launcher: LaunchRoleScopedRun = async (input) => {
    captured.push(input.intent)
    if (input.acpRunId !== undefined) {
      runStore.updateRun(input.acpRunId, {
        status: 'running',
        hrcRunId: 'hrc-causation-env',
        hostSessionId: 'host-causation-env',
        runtimeId: 'runtime-causation-env',
      })
    }
    return {
      runId: 'hrc-causation-env',
      sessionId: 'host-causation-env',
      hostSessionId: 'host-causation-env',
      runtimeId: 'runtime-causation-env',
    }
  }

  return {
    adminStore: createInMemoryAdminStore(),
    interfaceStore: inertInterfaceStore(),
    inputAttemptStore: new InMemoryInputAttemptStore(),
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputApplicationStore: new InMemoryInputApplicationStore(),
    inputQueueStore: new InMemoryInputQueueStore(),
    sessionAdmissionSequenceStore: new InMemorySessionAdmissionSequenceStore(),
    runStore,
    runtimeResolver: RUNTIME_RESOLVER,
    launchRoleScopedRun: launcher,
    authorize: () => 'allow',
    defaultActor: { kind: 'system', id: 'test' },
    inputQueuePolicy: {},
    pbcIdempotencyStore: {},
    pbcCaptureStore: {},
    wrkf: undefined,
  } as unknown as ResolvedAcpServerDeps
}

describe('job causation launch env', () => {
  test('immediate job dispatch injects WRKQ_CAUSATION_REF into launch env', async () => {
    const captured: HrcRuntimeIntent[] = []
    const deps = makeDeps(captured)

    await dispatchJobRunThroughInputs(deps, {
      jobId: 'job_immediate',
      jobRunId: 'jrun_immediate',
      scopeRef: SESSION_REF.scopeRef,
      laneRef: SESSION_REF.laneRef,
      content: 'run immediate job',
      causationRef: 'jrun_parent',
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]?.launch?.env?.[WRKQ_CAUSATION_REF_ENV]).toBe('jrun_parent')
  })

  test('queued job dispatch reconstructs WRKQ_CAUSATION_REF from stored run metadata', async () => {
    const captured: HrcRuntimeIntent[] = []
    const deps = makeDeps(captured)
    const blockingRun = deps.runStore.createRun({
      sessionRef: SESSION_REF,
      status: 'running',
    })

    const dispatch = await dispatchJobRunThroughInputs(deps, {
      jobId: 'job_queued',
      jobRunId: 'jrun_queued',
      scopeRef: SESSION_REF.scopeRef,
      laneRef: SESSION_REF.laneRef,
      content: 'run queued job',
      causationRef: 'jrun_parent',
    })

    expect(captured).toHaveLength(0)
    const queuedRun = deps.runStore.getRun(dispatch.runId)
    expect(causationLaunchEnvFromRunMetadata(queuedRun?.metadata)).toEqual({
      [WRKQ_CAUSATION_REF_ENV]: 'jrun_parent',
    })

    deps.runStore.updateRun(blockingRun.runId, { status: 'completed' })
    await createInputQueueDispatcher({
      ...deps,
      launchRoleScopedRun: deps.launchRoleScopedRun,
      config: { intervalMs: 60_000 },
    }).runOnce()

    expect(captured).toHaveLength(1)
    expect(captured[0]?.launch?.env?.[WRKQ_CAUSATION_REF_ENV]).toBe('jrun_parent')
  })
})
