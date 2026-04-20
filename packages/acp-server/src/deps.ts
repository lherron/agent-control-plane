import { type InputAttempt, type Preset, type Run, getPreset } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { CoordinationStore } from 'coordination-substrate'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { WrkqStore } from 'wrkq-lib'

import { InMemoryInputAttemptStore, type InputAttemptStore } from './domain/input-attempt-store.js'
import { InMemoryRunStore, type RunStore } from './domain/run-store.js'

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
}) => Promise<{ runId: string; sessionId: string }>

export interface AcpServerDeps {
  wrkqStore: WrkqStore
  coordStore: CoordinationStore
  presetRegistry?: PresetRegistry | undefined
  sessionResolver?: SessionResolver | undefined
  runtimeResolver?: RuntimeResolver | undefined
  agentRootResolver?: AgentRootResolver | undefined
  launchRoleScopedRun?: LaunchRoleScopedRun | undefined
  inputAttemptStore?: InputAttemptStore | undefined
  runStore?: RunStore | undefined
}

export interface ResolvedAcpServerDeps extends AcpServerDeps {
  presetRegistry: PresetRegistry
  inputAttemptStore: InputAttemptStore
  runStore: RunStore
}

export function resolveAcpServerDeps(deps: AcpServerDeps): ResolvedAcpServerDeps {
  return {
    ...deps,
    presetRegistry: deps.presetRegistry ?? { getPreset },
    inputAttemptStore: deps.inputAttemptStore ?? new InMemoryInputAttemptStore(),
    runStore: deps.runStore ?? new InMemoryRunStore(),
  }
}

export type { InputAttemptStore, RunStore, InputAttempt, Run }
