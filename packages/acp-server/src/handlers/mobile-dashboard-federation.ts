import type {
  FederationNodeRuntimeProjection,
  FederationPeerHealthObservation,
  FederationRuntimeProjectionReport,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { AcpHrcClient } from '../deps.js'
import { federatedSessionReadDeclared } from './mobile-session-access.js'
import {
  type MobileExecutionMode,
  type MobileSessionMode,
  type MobileSessionSummary,
  mobileStatus,
  modeForExecution,
  sessionRef,
} from './mobile-session-projection.js'

export type MobileNodeState = 'healthy' | 'unreachable' | 'refused' | 'invalid_response'

type MobileNodeSummary = {
  nodeId: string
  state: MobileNodeState
  checkedAt: string
  answeredAt?: string | undefined
  latencyMs: number
  // `protocolVersion` was retired from the federation wire upstream (hrc v1.3);
  // the probe no longer reports one, so the iOS wire no longer carries it.
  capabilities?: {
    accept: boolean
    locate: boolean
    health: boolean
    runtimeProjection?: boolean | undefined
  }
  detail?: string | undefined
}

export function thinLocalSessionForFederation(session: MobileSessionSummary): MobileSessionSummary {
  return {
    context: session.context,
    sessionRef: session.sessionRef,
    displayRef: session.displayRef,
    title: session.title,
    mode: session.mode,
    executionMode: session.executionMode,
    summaryStatus: session.summaryStatus,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(session.runtimeId !== undefined ? { runtimeId: session.runtimeId } : {}),
    ...(session.activeTurnId !== undefined ? { activeTurnId: session.activeTurnId } : {}),
    lastHrcSeq: session.lastHrcSeq,
    lastMessageSeq: session.lastMessageSeq,
    ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
    capabilities: {
      input: session.capabilities.input,
      interrupt: session.capabilities.interrupt,
      launchHeadlessTurn: session.capabilities.launchHeadlessTurn,
      history: session.capabilities.history,
    },
  }
}

export type MobileFederationSnapshot = {
  type: 'federation_snapshot'
  generatedAt: string
  localNodeId: string
  nodes: MobileNodeSummary[]
  sessions: MobileSessionSummary[]
  detail?: string | undefined
}

function projectMobileNodeState(
  state: FederationPeerHealthObservation['state'] | FederationNodeRuntimeProjection['state']
): MobileNodeState {
  if (state === 'answered' || state === 'healthy') return 'healthy'
  if (state === 'invalid-response') return 'invalid_response'
  return state
}

function projectRemoteRuntime(
  runtime: HrcRuntimeSnapshot,
  node: FederationNodeRuntimeProjection,
  federatedRead: boolean
): MobileSessionSummary {
  const execution: MobileExecutionMode =
    runtime.transport === 'headless'
      ? 'headless'
      : runtime.supportsInflightInput
        ? 'interactive'
        : 'nonInteractive'
  const mode: MobileSessionMode = modeForExecution(execution, runtime)
  const status = mobileStatus(runtime.status, runtime)
  const projectionState =
    node.state === 'invalid-response' ? ('invalid_response' as const) : node.state
  return {
    nodeId: node.nodeId,
    sourceKind: 'remote_runtime_projection',
    projectionState,
    projectionCheckedAt: node.checkedAt,
    ...(node.answeredAt !== undefined ? { projectionAnsweredAt: node.answeredAt } : {}),
    sessionRef: sessionRef(runtime.scopeRef, runtime.laneRef),
    displayRef: sessionRef(runtime.scopeRef, runtime.laneRef),
    title: runtime.identity?.agentId ?? runtime.scopeRef,
    mode,
    executionMode: execution,
    summaryStatus: status,
    status,
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    ...(runtime.activeRunId !== undefined ? { activeTurnId: runtime.activeRunId } : {}),
    // Remote projections never pretend that a peer-local cursor belongs to svc.
    lastHrcSeq: 0,
    lastMessageSeq: 0,
    lastActivityAt: runtime.lastActivityAt ?? runtime.updatedAt,
    capabilities: {
      input: false,
      interrupt: false,
      launchHeadlessTurn: false,
      history: federatedRead,
      summary: true,
      semanticDm: true,
      timeline: federatedRead,
      literalInput: false,
      answerPrompt: false,
    },
    session: {
      status: runtime.status,
      generation: runtime.generation,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    },
    runtime: {
      status: runtime.status,
      transport: runtime.transport,
      runtimeId: runtime.runtimeId,
      ...(runtime.activeRunId !== undefined ? { activeRunId: runtime.activeRunId } : {}),
      ...(runtime.lastActivityAt !== undefined ? { lastActivityAt: runtime.lastActivityAt } : {}),
      supportsInflightInput: runtime.supportsInflightInput,
      adopted: false as const,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    },
  }
}

export async function buildMobileFederationSnapshot(
  hrcClient: AcpHrcClient,
  fallbackNodeId: string
): Promise<MobileFederationSnapshot> {
  const generatedAt = new Date().toISOString()
  if (
    hrcClient.listFederationPeerHealth === undefined ||
    hrcClient.listFederatedRuntimes === undefined
  ) {
    return {
      type: 'federation_snapshot',
      generatedAt,
      localNodeId: fallbackNodeId,
      nodes: [],
      sessions: [],
      detail: 'Installed HRC does not expose federation projections.',
    }
  }

  const [healthResult, runtimeResult] = await Promise.allSettled([
    hrcClient.listFederationPeerHealth(),
    hrcClient.listFederatedRuntimes({}),
  ])
  const federatedRead = await federatedSessionReadDeclared(hrcClient)
  const observations = healthResult.status === 'fulfilled' ? healthResult.value : []
  const report: FederationRuntimeProjectionReport | undefined =
    runtimeResult.status === 'fulfilled' ? runtimeResult.value : undefined
  const localNodeId = report?.localNodeId ?? fallbackNodeId
  const nodes = new Map<string, MobileNodeSummary>()

  if (report !== undefined) {
    nodes.set(localNodeId, {
      nodeId: localNodeId,
      state: 'healthy',
      checkedAt: report.generatedAt,
      answeredAt: report.generatedAt,
      latencyMs: 0,
      capabilities: { accept: false, locate: true, health: true, runtimeProjection: true },
    })
    for (const node of report.nodes) {
      nodes.set(node.nodeId, {
        nodeId: node.nodeId,
        state: projectMobileNodeState(node.state),
        checkedAt: node.checkedAt,
        ...(node.answeredAt !== undefined ? { answeredAt: node.answeredAt } : {}),
        latencyMs: node.latencyMs,
        ...(node.detail !== undefined ? { detail: node.detail } : {}),
      })
    }
  }

  for (const observation of observations) {
    const existing = nodes.get(observation.nodeId)
    nodes.set(observation.nodeId, {
      nodeId: observation.nodeId,
      state: projectMobileNodeState(observation.state),
      checkedAt: observation.checkedAt,
      ...(observation.answeredAt !== undefined
        ? { answeredAt: observation.answeredAt }
        : existing?.answeredAt !== undefined
          ? { answeredAt: existing.answeredAt }
          : {}),
      latencyMs: observation.latencyMs,
      ...(observation.capabilities !== undefined
        ? {
            capabilities: {
              // `accept` was retired upstream (T-07616); keep it on the iOS wire, always false.
              accept: false,
              locate: observation.capabilities.locate,
              health: observation.capabilities.health,
              ...(observation.capabilities.runtimeProjection !== undefined
                ? { runtimeProjection: observation.capabilities.runtimeProjection }
                : {}),
            },
          }
        : existing?.capabilities !== undefined
          ? { capabilities: existing.capabilities }
          : {}),
      ...(observation.detail !== undefined
        ? { detail: observation.detail }
        : existing?.detail !== undefined
          ? { detail: existing.detail }
          : {}),
    })
  }

  const details: string[] = []
  if (healthResult.status === 'rejected') {
    details.push(
      `peer health unavailable: ${healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)}`
    )
  }
  if (runtimeResult.status === 'rejected') {
    details.push(
      `runtime projection unavailable: ${runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason)}`
    )
  }

  return {
    type: 'federation_snapshot',
    generatedAt: report?.generatedAt ?? generatedAt,
    localNodeId,
    nodes: [...nodes.values()].sort((lhs, rhs) => lhs.nodeId.localeCompare(rhs.nodeId)),
    sessions:
      report?.nodes
        .filter((node) => node.nodeId !== localNodeId)
        .flatMap((node) =>
          node.runtimes.map((runtime) => projectRemoteRuntime(runtime, node, federatedRead))
        ) ?? [],
    ...(details.length > 0 ? { detail: details.join(' ') } : {}),
  }
}
