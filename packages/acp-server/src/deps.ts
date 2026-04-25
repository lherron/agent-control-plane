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
import type { AcpStateStore } from 'acp-state-store'
import type { SessionRef } from 'agent-scope'
import type { CoordinationStore } from 'coordination-substrate'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import type { WrkqStore } from 'wrkq-lib'

import { InMemoryInputAttemptStore, type InputAttemptStore } from './domain/input-attempt-store.js'
import { InMemoryRunStore, type RunStore } from './domain/run-store.js'

export const DEFAULT_INTERFACE_DB_PATH = '/Users/lherron/praesidium/var/db/acp-interface.db'
export const DEFAULT_STATE_DB_PATH = '/Users/lherron/praesidium/var/db/acp-state.db'

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
}) => Promise<{ runId: string; sessionId: string }>

export type AcpHrcClient = Pick<
  HrcClient,
  | 'capture'
  | 'clearContext'
  | 'getAttachDescriptor'
  | 'getSession'
  | 'interrupt'
  | 'listRuntimes'
  | 'listSessions'
  | 'resolveSession'
  | 'terminate'
  | 'watch'
>

export interface AcpServerDeps {
  wrkqStore: WrkqStore
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
  hrcClient?: AcpHrcClient | undefined
  inputAttemptStore?: InputAttemptStore | undefined
  runStore?: RunStore | undefined
  mediaStateDir?: string | undefined
  attachmentMaxBytes?: number | undefined
  attachmentFetchImpl?: typeof fetch | undefined
  deliveryTargetResolver?: DeliveryTargetResolver | undefined
  authorize?: AuthorizeFn | undefined
}

export interface ResolvedAcpServerDeps extends AcpServerDeps {
  adminStore: AdminStore
  interfaceStore: InterfaceStore
  presetRegistry: PresetRegistry
  stateStore?: AcpStateStore | undefined
  inputAttemptStore: InputAttemptStore
  runStore: RunStore
  authorize: AuthorizeFn
  defaultActor: Actor
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
    runStore: deps.runStore ?? stateStore?.runs ?? new InMemoryRunStore(),
    authorize: deps.authorize ?? (() => 'allow'),
    defaultActor: deps.defaultActor ?? { kind: 'system', id: 'acp-local' },
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
