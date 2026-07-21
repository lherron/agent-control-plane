import type { WorkClient } from '@wrkq/client'
import { type AdminStore, createInMemoryAdminStore } from 'acp-admin-store'
import type { ConversationStore } from 'acp-conversation'
import {
  type Actor,
  type DeliveryTarget,
  type InputAttempt,
  type Preset,
  type Run,
  getPreset,
} from 'acp-core'
import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'
import type { JobsStore } from 'acp-jobs-store'
import type { NativeStepExecutorDeps } from 'acp-jobs-store'
import type { AcpStateStore } from 'acp-state-store'
import type { SessionRef } from 'agent-scope'
import type { CoordinationStore } from 'coordination-substrate'
import type {
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcRuntimeIntent,
  LaunchCommandScopedRunBinding,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import type { WrkqStoreAdapter } from 'wrkq-lib'

import {
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
  type InputAdmissionStore,
  type InputApplicationStore,
  type InputQueueStore,
  type SessionAdmissionSequenceStore,
} from './domain/input-admission-stores.js'
import { InMemoryInputAttemptStore, type InputAttemptStore } from './domain/input-attempt-store.js'
import { InMemoryRunStore, type RunStore, type StoredRun } from './domain/run-store.js'
import type { JobExecPolicy } from './jobs/exec-policy.js'
import {
  InMemoryWrkfParticipantCaptureStore,
  InMemoryWrkfRouteIdempotencyStore,
  type WrkfParticipantCaptureStore,
  type WrkfRouteIdempotencyStore,
  createDurableWrkfStores,
} from './wrkf/pbc-route-idempotency-store.js'
import type { AcpWrkfWorkflowPort } from './wrkf/port.js'

export const DEFAULT_INTERFACE_DB_PATH = '/Users/lherron/praesidium/var/db/acp-interface.db'
export const DEFAULT_STATE_DB_PATH = '/Users/lherron/praesidium/var/db/acp-state.db'
export const DEFAULT_AGENT_ASSETS_DIR =
  '/Users/lherron/praesidium/var/state/acp-server/assets/agents'

export interface PresetRegistry {
  getPreset(presetId: string, version: number): Preset
}

export interface AcpRuntimePlacement {
  agentRoot: string
  projectRoot?: string | undefined
  cwd?: string | undefined
  runMode?: string | undefined
  bundle?: { kind: string; [key: string]: unknown } | undefined
  correlation?: { sessionRef: SessionRef } | undefined
  [key: string]: unknown
}

export type InputQueuePolicy = {
  maxDepth?: number | undefined
  ttlMs?: number | undefined
}

export type RunLivenessResolver = (
  run: StoredRun
) => string | undefined | Promise<string | undefined>

export type SessionResolver = (
  sessionRef: SessionRef
) => string | undefined | Promise<string | undefined>

export type RuntimeResolver = (
  sessionRef: SessionRef
) => AcpRuntimePlacement | undefined | Promise<AcpRuntimePlacement | undefined>

export type AgentRootResolver = (input: { agentId: string; sessionRef: SessionRef }) =>
  | string
  | undefined
  | Promise<string | undefined>

export type LaunchRoleScopedRun = (input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  acpRunId?: string | undefined
  inputAttemptId?: string | undefined
  runStore?: RunStore | undefined
  onEvent?: ((event: UnifiedSessionEvent) => void | Promise<void>) | undefined
  waitForCompletion?: boolean | undefined
}) => Promise<{
  runId: string
  sessionId: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  launchId?: string | undefined
  generation?: number | undefined
}>

export type LaunchCommandScopedRun = (input: {
  configuredTargetId: string
  sessionRef: SessionRef
  idempotencyKey: string
  binding: LaunchCommandScopedRunBinding
  stdinJson?: unknown | undefined
}) => Promise<{
  runId: string
  hostSessionId: string
  runtimeId: string
  generation: number
  transport: string
  launchId?: string | undefined
  replayed?: boolean | undefined
}>

export type AcpHrcClient = Pick<
  HrcClient,
  | 'capture'
  | 'clearContext'
  | 'deliverLiteralBySelector'
  | 'getHealth'
  | 'getAttachDescriptor'
  | 'getSession'
  | 'interrupt'
  | 'listLatestEventBySession'
  | 'listMessages'
  | 'listRuns'
  | 'listRuntimes'
  | 'getLatestRunForSession'
  | 'listTargets'
  | 'listSessions'
  | 'launchCommandScopedRun'
  | 'locateScope'
  | 'resolveSession'
  | 'sendInFlightInput'
  | 'semanticDm'
  | 'startRuntime'
  | 'terminate'
  | 'waitMessage'
  | 'watch'
  | 'watchMessages'
> & {
  probe?(request: Readonly<Record<string, unknown>>): Promise<{ outcome: 'idle' | 'work' }>
  submitActiveRunContribution(
    request: HrcActiveRunContributionRequest
  ): Promise<HrcActiveRunContributionResponse>
  getActiveRunContribution(inputApplicationId: string): Promise<HrcActiveRunContributionResponse>
}

export interface AcpServerDeps {
  // The four acp-core store ports, served by the @wrkq/client-backed adapter
  // (wrkq-lib createWrkqStoreAdapter). Optional: when wrkf is disabled
  // (ACP_WRKF_DISABLED) there is no client and thus no wrkq store — the server
  // runs degraded (no task/role-backed launch). ACP never opens wrkq.db itself.
  wrkqStore?: WrkqStoreAdapter | undefined
  coordStore: CoordinationStore
  defaultActor?: Actor | undefined
  adminStore?: AdminStore | undefined
  jobsStore?: JobsStore | undefined
  conversationStore?: ConversationStore | undefined
  interfaceStore?: InterfaceStore | undefined
  stateStore?: AcpStateStore | undefined
  presetRegistry?: PresetRegistry | undefined
  sessionResolver?: SessionResolver | undefined
  runtimeResolver?: RuntimeResolver | undefined
  agentRootResolver?: AgentRootResolver | undefined
  launchRoleScopedRun?: LaunchRoleScopedRun | undefined
  launchCommandScopedRun?: LaunchCommandScopedRun | undefined
  triageCommandTargetId?: string | undefined
  implCommandTargetId?: string | undefined
  verifyCommandTargetId?: string | undefined
  verifyCommandSessionRef?: SessionRef | undefined
  hrcClient?: AcpHrcClient | undefined
  inputAttemptStore?: InputAttemptStore | undefined
  inputAdmissionStore?: InputAdmissionStore | undefined
  inputApplicationStore?: InputApplicationStore | undefined
  inputQueueStore?: InputQueueStore | undefined
  sessionAdmissionSequenceStore?: SessionAdmissionSequenceStore | undefined
  runStore?: RunStore | undefined
  runLivenessResolver?: RunLivenessResolver | undefined
  mediaStateDir?: string | undefined
  attachmentMaxBytes?: number | undefined
  attachmentFetchImpl?: typeof fetch | undefined
  deliveryTargetResolver?: DeliveryTargetResolver | undefined
  authorize?: AuthorizeFn | undefined
  jobExecPolicy?: JobExecPolicy | undefined
  nativeStepExecutor?: Omit<NativeStepExecutorDeps, 'store'> | undefined
  inputQueuePolicy?: InputQueuePolicy | undefined
  agentAssetsDir?: string | undefined
  workClient?: WorkClient | undefined
  wrkf?: AcpWrkfWorkflowPort | undefined
  pbcIdempotencyStore?: WrkfRouteIdempotencyStore | undefined
  pbcCaptureStore?: WrkfParticipantCaptureStore | undefined
}

export interface ResolvedAcpServerDeps extends AcpServerDeps {
  adminStore: AdminStore
  interfaceStore: InterfaceStore
  presetRegistry: PresetRegistry
  stateStore?: AcpStateStore | undefined
  inputAttemptStore: InputAttemptStore
  inputAdmissionStore: InputAdmissionStore
  inputApplicationStore: InputApplicationStore
  inputQueueStore: InputQueueStore
  sessionAdmissionSequenceStore: SessionAdmissionSequenceStore
  runStore: RunStore
  authorize: AuthorizeFn
  defaultActor: Actor
  inputQueuePolicy: InputQueuePolicy
  nativeStepExecutor?: Omit<NativeStepExecutorDeps, 'store'> | undefined
  workClient?: WorkClient | undefined
  wrkf: AcpWrkfWorkflowPort | undefined
  pbcIdempotencyStore: WrkfRouteIdempotencyStore
  pbcCaptureStore: WrkfParticipantCaptureStore
}

export type DeliveryTargetResolver = (input: {
  request: Request
  body?: unknown | undefined
  actor?: Actor | undefined
}) => DeliveryTarget | undefined | Promise<DeliveryTarget | undefined>

export type AuthorizeFn = (
  actor: Actor,
  operation: string,
  resource: { kind: string; id?: string | undefined }
) => 'allow' | 'deny'

export function resolveAcpServerDeps(deps: AcpServerDeps): ResolvedAcpServerDeps {
  const stateStore = deps.stateStore
  const useStateInputStores = deps.inputAttemptStore === undefined && deps.runStore === undefined
  const durableWrkfStores =
    stateStore !== undefined ? createDurableWrkfStores(stateStore) : undefined

  return {
    ...deps,
    adminStore: deps.adminStore ?? createInMemoryAdminStore(),
    interfaceStore:
      deps.interfaceStore ??
      openInterfaceStore({
        dbPath: process.env['ACP_INTERFACE_DB_PATH'] ?? DEFAULT_INTERFACE_DB_PATH,
      }),
    ...(stateStore !== undefined ? { stateStore } : {}),
    presetRegistry: deps.presetRegistry ?? { getPreset },
    inputAttemptStore:
      deps.inputAttemptStore ?? stateStore?.inputAttempts ?? new InMemoryInputAttemptStore(),
    inputAdmissionStore:
      deps.inputAdmissionStore ??
      (useStateInputStores ? stateStore?.inputAdmissions : undefined) ??
      new InMemoryInputAdmissionStore(),
    inputApplicationStore:
      deps.inputApplicationStore ??
      (useStateInputStores ? stateStore?.inputApplications : undefined) ??
      new InMemoryInputApplicationStore(),
    inputQueueStore:
      deps.inputQueueStore ??
      (useStateInputStores ? stateStore?.inputQueue : undefined) ??
      new InMemoryInputQueueStore(),
    sessionAdmissionSequenceStore:
      deps.sessionAdmissionSequenceStore ??
      (useStateInputStores ? stateStore?.sessionAdmissionSequences : undefined) ??
      new InMemorySessionAdmissionSequenceStore(),
    runStore: deps.runStore ?? stateStore?.runs ?? new InMemoryRunStore(),
    authorize: deps.authorize ?? (() => 'allow'),
    defaultActor: deps.defaultActor ?? { kind: 'system', id: 'acp-local' },
    inputQueuePolicy: deps.inputQueuePolicy ?? {},
    ...(deps.nativeStepExecutor !== undefined
      ? { nativeStepExecutor: deps.nativeStepExecutor }
      : {}),
    ...(deps.workClient !== undefined ? { workClient: deps.workClient } : {}),
    wrkf: deps.wrkf,
    pbcIdempotencyStore:
      deps.pbcIdempotencyStore ??
      durableWrkfStores?.idempotencyStore ??
      new InMemoryWrkfRouteIdempotencyStore(),
    pbcCaptureStore:
      deps.pbcCaptureStore ??
      durableWrkfStores?.captureStore ??
      new InMemoryWrkfParticipantCaptureStore(),
  }
}

export type {
  InputAttemptStore,
  RunStore,
  InputAttempt,
  Run,
  AdminStore,
  ConversationStore,
  JobsStore,
}
