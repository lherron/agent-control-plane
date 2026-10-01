import type { WorkClient } from '@wrkq/client'
import type { WrkqTask } from '@wrkq/client/wrkq'
import { isTerminalRuntimeStatus } from 'hrc-core'
import {
  HrcClient,
  buildHrcRuntimeIntent,
  discoverSocket,
  isAgentNotFoundError,
  resolvePlacementObservation,
  resolveProfileAwareScopeInput,
} from 'hrc-sdk'

import {
  type HolderLiveness,
  type RequestClaim,
  type RequestFacts,
  type RequestRecord,
  STALL_FACT_TYPE,
  START_FACT_TYPE,
  type SeatObservation,
  type StallFact,
  type StartFact,
  type WorkerRef,
  type WorkerValidity,
  parseRequestMarker,
  scopeRefOfSession,
} from './model.js'

/** Everything a scan or an explain reads. Explain is handed only this. */
export interface ReconcilerReader {
  localNodeId(): Promise<string>
  listRequests(): Promise<RequestRecord[]>
  readFacts(request: RequestRecord): Promise<RequestFacts>
  holderLiveness(claim: RequestClaim, localNodeId: string): Promise<HolderLiveness>
  workerValidity(worker: WorkerRef): Promise<WorkerValidity>
  seatSession(scopeRef: string): Promise<SeatObservation>
}

export type FactPost = Readonly<{
  task: string
  type: string
  key: string
  summary: string
  attributes: Record<string, string>
}>

/** Every write the reconciler makes. */
export interface ReconcilerWriter {
  /** `created` when this call wrote the fact; `existing` on an idempotent replay. */
  postFact(fact: FactPost): Promise<'created' | 'existing'>
  startWorker(input: Readonly<{ seat: string; body: string; startKey: string }>): Promise<void>
  notify(
    input: Readonly<{ task: string; to: string; body: string; key: string }>
  ): Promise<'sent' | 'duplicate'>
}

const UNFINISHED_LIST_STATES = ['idea', 'draft', 'open', 'in_progress', 'blocked'] as const
const LIST_PAGE = 500

function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function createWrkqReader(
  client: WorkClient
): Pick<ReconcilerReader, 'listRequests' | 'readFacts'> {
  return {
    async listRequests() {
      const marked: WrkqTask[] = []
      let cursor: string | undefined
      do {
        const page = await client.wrkq.task.list({
          subtasks: true,
          state: [...UNFINISHED_LIST_STATES],
          summary: true,
          limit: LIST_PAGE,
          ...(cursor !== undefined ? { cursor } : {}),
        })
        for (const task of page.items) {
          if (parseRequestMarker(task.meta ?? {}) !== undefined) marked.push(task)
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)

      // A task's projectUuid names its immediate container (often a directory
      // such as `inbox`); the HRC project and the timeline need the enclosing
      // `kind: project` container.
      const projects = new Map<string, { id: string; path: string }>()
      const owningProject = async (containerUuid: string) => {
        const visited: string[] = []
        let uuid: string | undefined = containerUuid
        let found = projects.get(containerUuid)
        while (found === undefined && uuid !== undefined) {
          visited.push(uuid)
          const container = await client.wrkq.container.show({ project: uuid })
          if (container.kind === 'project') found = { id: container.id, path: container.path }
          else uuid = container.parentUuid
        }
        if (found === undefined)
          throw new Error(`container ${containerUuid} has no enclosing project`)
        for (const each of visited) projects.set(each, found)
        return found
      }
      const owners = new Map<string, boolean>()
      const records: RequestRecord[] = []
      for (const task of marked) {
        const project = await owningProject(task.projectUuid)
        let ownerGone: boolean | undefined
        if (task.subtaskOwner !== undefined) {
          ownerGone = owners.get(task.subtaskOwner)
          if (ownerGone === undefined) {
            const owner = await client.wrkq.task.show({ task: task.subtaskOwner })
            ownerGone =
              owner.state === 'archived' ||
              owner.state === 'deleted' ||
              owner.deletedAt !== undefined
            owners.set(task.subtaskOwner, ownerGone)
          }
        }
        const claim =
          task.claimedBy !== undefined && task.claimedScope !== undefined
            ? {
                by: task.claimedBy,
                scope: task.claimedScope,
                node: task.claimedNode ?? '',
                generation: task.claimGeneration ?? 0,
              }
            : undefined
        records.push({
          id: task.id,
          projectId: project.path,
          projectContainerId: project.id,
          state: task.archivedAt !== undefined ? 'archived' : task.state,
          priority: task.priority,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          assigneePrincipalRef: optionalString(task.assigneePrincipalRef),
          requesterPrincipalRef: optionalString(task.requesterPrincipalRef),
          requesterScopeRef: optionalString(task.requesterScopeRef),
          marker: parseRequestMarker(task.meta ?? {}) ?? { ok: false, reason: 'marker vanished' },
          claim,
          claimGeneration: task.claimGeneration,
          ownerId: task.subtaskOwner,
          ownerGone,
        })
      }
      return records
    },

    async readFacts(request) {
      const starts: StartFact[] = []
      const stalls: StallFact[] = []
      let cursor: string | undefined
      do {
        const view = await client.wrkq.container.timelineView({
          // Paths resolve against the connection's project root; the id does not.
          container: request.projectContainerId ?? request.projectId,
          task: request.id,
          scope: 'subtree',
          types: [START_FACT_TYPE, STALL_FACT_TYPE],
          entriesOnly: true,
          ...(cursor !== undefined ? { cursor } : {}),
        })
        for (const entry of view.entries) {
          if (entry.type !== 'project.event' || entry.taskId !== request.id) continue
          const fact = entry.projectEvent
          const attributes = fact.attributes
          if (fact.type === START_FACT_TYPE && attributes['start_key'] !== undefined) {
            starts.push({
              startKey: attributes['start_key'],
              rev: attributes['rev'] ?? '',
              assigneeSeat: attributes['assignee_seat'] ?? '',
              occurredAt: fact.occurredAt,
            })
          } else if (fact.type === STALL_FACT_TYPE && attributes['kind'] !== undefined) {
            stalls.push({
              kind: attributes['kind'],
              episode: attributes['episode'] ?? '',
              occurredAt: fact.occurredAt,
            })
          }
        }
        cursor = view.nextCursor
      } while (cursor !== undefined)
      return { starts, stalls }
    },
  }
}

export function createWrkqWriter(
  client: WorkClient,
  principalRef: string
): Pick<ReconcilerWriter, 'postFact' | 'notify'> {
  return {
    async postFact(fact) {
      const result = await client.wrkq.projectEvent.post({
        task: fact.task,
        type: fact.type,
        summary: fact.summary,
        attributes: fact.attributes,
        idempotencyKey: fact.key,
        principalRef,
      })
      return result.created ? 'created' : 'existing'
    },
    async notify(input) {
      try {
        await client.wrkq.room.say({
          ref: input.task,
          body: input.body,
          to: [input.to],
          fyi: true,
          idempotencyKey: input.key,
          principalRef,
        })
        return 'sent'
      } catch (error) {
        // A replayed idempotency key is refused, not deduplicated: the notice
        // for this episode already went out.
        if (error instanceof Error && /idempot|unique|duplicate/i.test(error.message)) {
          return 'duplicate'
        }
        throw error
      }
    },
  }
}

export type HrcPortOptions = Readonly<{
  principalRef: string
  client?: HrcClient | undefined
  socketPath?: string | undefined
}>

async function resolveSeat(seat: string, socketPath: string | undefined) {
  return resolveProfileAwareScopeInput(seat, {
    scope: { defaultLaneId: 'main' },
    projectOrigin: 'explicit',
    placement: { taskWorktreeAssociation: 'strict' },
    ...(socketPath !== undefined ? { socketPath } : {}),
  })
}

export function createHrcPort(
  options: HrcPortOptions
): Pick<ReconcilerReader, 'localNodeId' | 'holderLiveness' | 'workerValidity' | 'seatSession'> &
  Pick<ReconcilerWriter, 'startWorker'> {
  const socketPath = options.socketPath
  const client = options.client ?? new HrcClient(socketPath ?? discoverSocket())
  return {
    async localNodeId() {
      const status = await client.getStatus({ includeSessions: false })
      const nodeId = status.node?.nodeId?.trim()
      if (!nodeId) throw new Error('HRC status carries no node id')
      return nodeId
    },

    async holderLiveness(claim, localNodeId) {
      // HRC on this node only knows this node's runtimes; a holder placed on
      // another node is unknown, never ended.
      if (claim.node !== localNodeId) return 'unknown'
      try {
        const runtimes = await client.listRuntimes({
          scope: scopeRefOfSession(claim.scope),
          all: true,
        })
        if (runtimes.length === 0) return 'unknown'
        return runtimes.every((runtime) => isTerminalRuntimeStatus(runtime.status))
          ? 'ended'
          : 'live'
      } catch {
        return 'unknown'
      }
    },

    async workerValidity(worker) {
      // The same daemon placement resolution resolveProfileAwareScopeInput uses,
      // read whole: it also carries the launch policy HRC's summon gate enforces.
      try {
        const observation = await resolvePlacementObservation({
          agentId: worker.agentId,
          projectId: worker.projectId,
          taskId: worker.taskId,
          projectOrigin: 'explicit',
          taskWorktreeAssociation: 'strict',
          ...(socketPath !== undefined ? { socketPath } : {}),
        })
        if (observation.agentRoot === undefined) return { ok: false, reason: 'agent not found' }
        if (observation.policy.placement.launch === 'participant-only') {
          return { ok: false, reason: `participant-only (${worker.agentId})` }
        }
        return { ok: true }
      } catch (error) {
        if (isAgentNotFoundError(error)) return { ok: false, reason: 'agent not found' }
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },

    async seatSession(scopeRef) {
      try {
        return (await client.listSessions({ scopeRef })).length > 0 ? 'session' : 'none'
      } catch {
        return 'unknown'
      }
    },

    async startWorker({ seat, body, startKey }) {
      const resolved = await resolveSeat(seat, socketPath)
      const placement = resolved.placement
      if (placement.agentRoot === undefined) throw new Error(`agent for ${seat} not found`)
      const runtimeIntent = await buildHrcRuntimeIntent({
        agentId: resolved.parsed.agentId,
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        cwd: placement.cwd ?? placement.agentRoot,
        runMode: 'task',
        interactive: false,
        preferredMode: 'nonInteractive',
      })
      const sessionRef = `${resolved.scopeRef}/lane:${resolved.laneId}`
      await client.ensureTarget({ sessionRef, runtimeIntent, birthCause: 'assignment' })
      await client.enqueue({
        target: sessionRef,
        body,
        runtimeIntent,
        idempotencyKey: startKey,
        origin: { principalRef: options.principalRef },
      })
    },
  }
}
