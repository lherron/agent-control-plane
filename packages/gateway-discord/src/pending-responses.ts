import type { InterfaceSessionRef } from 'acp-core'
import type { Client } from 'discord.js'
import type { GatewayAcpClient } from './acp-client.js'
import { type adaptHrcLifecycleEvent, canonicalSessionRefFromEvent } from './hrc-event-adapter.js'
import type { DiscordAgentMessageIdentity } from './identity.js'
import type { RunState } from './session-events-manager.js'
import type { RenderFrame, UiHandle } from './types.js'

import type { DiscordOutput } from './discord-output.js'
import { canonicalSessionRefString } from './discord-session-ref.js'
import { log } from './gateway-log.js'
import { asRecord, pickNonEmptyString, truncateReason } from './ingress-failure.js'
import type { LedgerInFlight } from './ledger-responses.js'

const PENDING_PLACEHOLDER_TIMEOUT_MS = 300_000
export type PendingPlaceholder = {
  ui: UiHandle & { kind: 'message' }
  sessionRef: string
  projectId: string
  pendingSince: number
  acpRunId?: string | undefined
  claimedHrcRunId?: string | undefined
  expectedHrcRunId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  identity?: DiscordAgentMessageIdentity | undefined
  promptPreview?: string | undefined
  pendingTimeout: ReturnType<typeof setTimeout>
  runTimeout: ReturnType<typeof setTimeout>
  typingTimer?: ReturnType<typeof setInterval> | undefined
  flushTimer?: ReturnType<typeof setTimeout> | undefined
  disableTimer?: ReturnType<typeof setTimeout> | undefined
  pendingFrame?: RenderFrame | undefined
  pendingRun?: RunState | undefined
  cancelRequested?: boolean | undefined
  cancelDispatching?: boolean | undefined
  cancelActorId?: string | undefined
  editDisabled: boolean
  webhookGone: boolean
  lastSuccessfulEditAt: number
  ledgerInFlight?: LedgerInFlight | undefined
}

export function eventTimestampIsClaimable(input: {
  pendingSince: number
  eventTs?: string | undefined
}): boolean {
  if (input.eventTs === undefined || input.eventTs.trim().length === 0) {
    return false
  }

  const eventMs = Date.parse(input.eventTs)
  if (!Number.isFinite(eventMs)) {
    return false
  }

  return input.pendingSince <= eventMs
}

type AcpRunLookupResponse = {
  run?: {
    status?: string | undefined
    hrcRunId?: string | undefined
    hostSessionId?: string | undefined
    runtimeId?: string | undefined
    generation?: number | undefined
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
  queue?: {
    status?: string | undefined
    seq?: number | undefined
  }
}

export class PendingResponses {
  readonly placeholdersByRunId = new Map<string, PendingPlaceholder>()
  private readonly pendingPlaceholdersBySessionRef = new Map<string, PendingPlaceholder[]>()
  readonly activePlaceholdersByMessageId = new Map<string, PendingPlaceholder>()
  constructor(
    private readonly options: {
      acp: Pick<GatewayAcpClient, 'baseUrl' | 'fetch'>
      client: Client
      ensureLiveSubscriptionForSessionRef: (sessionRef: string, projectId: string) => void
      failPlaceholder: DiscordOutput['failPlaceholder']
      gatewayId: string
      liveProgressTimeoutMs: number
      releaseRun: (sessionRef: string, runId: string) => void
      retireLedgerInFlight: (
        inFlight: LedgerInFlight,
        reason: string,
        options: { notice?: string }
      ) => Promise<boolean>
      typingRefreshMs: number
    }
  ) {}

  clear(): void {
    for (const placeholder of this.placeholdersByRunId.values()) {
      this.clearPlaceholderTimers(placeholder)
    }
    for (const placeholders of this.pendingPlaceholdersBySessionRef.values()) {
      for (const placeholder of placeholders) this.clearPlaceholderTimers(placeholder)
    }
    this.placeholdersByRunId.clear()
    this.pendingPlaceholdersBySessionRef.clear()
    this.activePlaceholdersByMessageId.clear()
  }

  registerPendingPlaceholder(input: {
    placeholder: UiHandle & {
      kind: 'message'
      webhookId?: string
      identity?: DiscordAgentMessageIdentity
    }
    sessionRef: InterfaceSessionRef
    projectId: string
    promptPreview: string
  }): PendingPlaceholder {
    const sessionRef = canonicalSessionRefString(input.sessionRef)
    const pending: PendingPlaceholder = {
      ui: input.placeholder,
      sessionRef,
      projectId: input.projectId,
      pendingSince: Date.now(),
      identity: input.placeholder.identity,
      promptPreview: input.promptPreview,
      pendingTimeout: setTimeout(() => {
        log.warn('gw.live_progress.pending_timeout', {
          message: 'Pending placeholder was not claimed by any HRC run',
          trace: { gatewayId: this.options.gatewayId, projectId: input.projectId },
          data: { sessionRef, timeoutMs: PENDING_PLACEHOLDER_TIMEOUT_MS },
        })
        if (pending.ledgerInFlight !== undefined) {
          void this.options.retireLedgerInFlight(pending.ledgerInFlight, 'pending_timeout', {
            notice: `Reply timed out before an agent run started — full details: wrkc show ${pending.ledgerInFlight.inputEnvelopeId}`,
          })
        } else {
          this.removePendingPlaceholder(pending, 'pending_timeout')
          void this.describePendingPlaceholderTimeout(pending).then((reason) =>
            this.options.failPlaceholder(pending.ui, reason)
          )
        }
      }, PENDING_PLACEHOLDER_TIMEOUT_MS),
      runTimeout: setTimeout(() => {
        log.warn('gw.live_progress.run_timeout', {
          message: 'Live progress run timed out before turn_end',
          trace: { gatewayId: this.options.gatewayId, projectId: input.projectId },
          data: {
            sessionRef,
            acpRunId: pending.acpRunId,
            claimedHrcRunId: pending.claimedHrcRunId,
            timeoutMs: this.options.liveProgressTimeoutMs,
          },
        })
        if (pending.ledgerInFlight !== undefined) {
          void this.options.retireLedgerInFlight(pending.ledgerInFlight, 'run_timeout', {
            notice: `Reply timed out before completion — full details: wrkc show ${pending.ledgerInFlight.inputEnvelopeId}`,
          })
        } else {
          this.removePendingPlaceholder(pending, 'run_timeout')
          void this.options.failPlaceholder(pending.ui, 'Reply timed out before completion.')
        }
      }, this.options.liveProgressTimeoutMs),
      editDisabled: false,
      webhookGone: false,
      lastSuccessfulEditAt: 0,
    }

    const list = this.pendingPlaceholdersBySessionRef.get(sessionRef) ?? []
    list.push(pending)
    this.pendingPlaceholdersBySessionRef.set(sessionRef, list)
    this.activePlaceholdersByMessageId.set(input.placeholder.id, pending)
    this.options.ensureLiveSubscriptionForSessionRef(sessionRef, input.projectId)

    const typingTargetId = input.placeholder.threadId ?? input.placeholder.channelId
    if (typingTargetId !== undefined) {
      pending.typingTimer = this.startTypingLoop(typingTargetId, sessionRef, input.projectId)
    }

    return pending
  }

  private startTypingLoop(
    channelId: string,
    sessionRef: string,
    projectId: string
  ): ReturnType<typeof setInterval> {
    void this.sendTypingPing(channelId, sessionRef, projectId)
    return setInterval(() => {
      void this.sendTypingPing(channelId, sessionRef, projectId)
    }, this.options.typingRefreshMs)
  }

  private async sendTypingPing(
    channelId: string,
    sessionRef: string,
    projectId: string
  ): Promise<void> {
    try {
      const channel = await this.options.client.channels.fetch(channelId)
      if (!channel || typeof (channel as { sendTyping?: unknown }).sendTyping !== 'function') {
        return
      }
      await (channel as { sendTyping: () => Promise<unknown> }).sendTyping()
      log.info('gw.discord.typing.refresh', {
        trace: { gatewayId: this.options.gatewayId, projectId },
        data: { channelId, sessionRef },
      })
    } catch (error) {
      log.warn('gw.discord.typing.error', {
        trace: { gatewayId: this.options.gatewayId, projectId },
        data: { channelId, sessionRef },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async describePendingPlaceholderTimeout(pending: PendingPlaceholder): Promise<string> {
    const elapsedSeconds = Math.round((Date.now() - pending.pendingSince) / 1000)
    const runId = pending.acpRunId
    if (runId === undefined) {
      return `ACP did not return a run id within ${elapsedSeconds}s, and no HRC progress events reached Discord.`
    }

    let payload: AcpRunLookupResponse | undefined
    try {
      const response = await this.options.acp.fetch(
        `${this.options.acp.baseUrl}/v1/runs/${encodeURIComponent(runId)}`
      )
      if (!response.ok) {
        return `ACP run ${runId} produced no HRC progress within ${elapsedSeconds}s, and status lookup returned HTTP ${response.status}.`
      }
      payload = (await response.json()) as AcpRunLookupResponse
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return truncateReason(
        `ACP run ${runId} produced no HRC progress within ${elapsedSeconds}s, and status lookup failed: ${reason}`
      )
    }

    const status = payload.run?.status
    const queueStatus = payload.queue?.status
    const queueSuffix =
      queueStatus !== undefined
        ? ` (queue ${queueStatus}${payload.queue?.seq !== undefined ? `, seq ${payload.queue.seq}` : ''})`
        : ''

    if (status === 'queued') {
      return `ACP queued run ${runId}${queueSuffix}, but it was not dispatched to HRC within ${elapsedSeconds}s. Another active or stale run is likely blocking this session.`
    }

    if (
      status === 'pending' &&
      payload.run?.hrcRunId === undefined &&
      payload.run?.hostSessionId === undefined
    ) {
      return `ACP accepted run ${runId}, but HRC launch did not record a session or run within ${elapsedSeconds}s.`
    }

    if (status === 'pending') {
      return `ACP run ${runId} is still pending after ${elapsedSeconds}s with partial HRC correlation; no progress events reached Discord.`
    }

    if (status === 'running') {
      const hrcSuffix =
        payload.run?.hrcRunId !== undefined ? ` (HRC run ${payload.run.hrcRunId})` : ''
      return `ACP run ${runId}${hrcSuffix} is running, but no HRC progress events reached Discord within ${elapsedSeconds}s.`
    }

    if (status === 'failed' || status === 'cancelled') {
      const error =
        payload.run?.errorMessage ?? payload.run?.errorCode ?? `run ended with status ${status}`
      return truncateReason(`ACP run ${runId} ended as ${status}: ${error}`)
    }

    return `ACP run ${runId} produced no HRC progress within ${elapsedSeconds}s; current ACP status is ${status ?? 'unknown'}.`
  }

  async refreshPendingPlaceholderCorrelation(placeholder: PendingPlaceholder): Promise<void> {
    if (placeholder.acpRunId === undefined) {
      return
    }

    let payload: AcpRunLookupResponse | undefined
    try {
      const response = await this.options.acp.fetch(
        `${this.options.acp.baseUrl}/v1/runs/${encodeURIComponent(placeholder.acpRunId)}`
      )
      if (!response.ok) {
        return
      }
      payload = (await response.json()) as AcpRunLookupResponse
    } catch {
      return
    }

    const run = payload.run
    const queueStatus = payload.queue?.status
    if (run?.status === 'queued' || queueStatus === 'queued' || queueStatus === 'dispatching') {
      placeholder.expectedHrcRunId = undefined
      placeholder.expectedHostSessionId = undefined
      placeholder.expectedGeneration = undefined
      return
    }

    if (typeof run?.hrcRunId === 'string' && run.hrcRunId.trim().length > 0) {
      placeholder.expectedHrcRunId = run.hrcRunId
      return
    }

    if (
      typeof run?.hostSessionId === 'string' &&
      run.hostSessionId.trim().length > 0 &&
      typeof run.runtimeId === 'string' &&
      run.runtimeId.trim().length > 0
    ) {
      placeholder.expectedHostSessionId = run.hostSessionId
      if (typeof run.generation === 'number' && Number.isFinite(run.generation)) {
        placeholder.expectedGeneration = run.generation
      }
    }
  }

  removePendingPlaceholder(placeholder: PendingPlaceholder, reason: string): void {
    const list = this.pendingPlaceholdersBySessionRef.get(placeholder.sessionRef)
    if (list !== undefined) {
      const next = list.filter((item) => item !== placeholder)
      if (next.length > 0) {
        this.pendingPlaceholdersBySessionRef.set(placeholder.sessionRef, next)
      } else {
        this.pendingPlaceholdersBySessionRef.delete(placeholder.sessionRef)
      }
    }

    if (placeholder.acpRunId !== undefined) {
      this.placeholdersByRunId.delete(placeholder.acpRunId)
    }
    this.activePlaceholdersByMessageId.delete(placeholder.ui.id)

    if (placeholder.claimedHrcRunId !== undefined) {
      this.options.releaseRun(placeholder.sessionRef, placeholder.claimedHrcRunId)
    }

    this.clearPlaceholderTimers(placeholder)
    log.debug('gw.live_progress.placeholder_removed', {
      trace: { gatewayId: this.options.gatewayId, projectId: placeholder.projectId },
      data: {
        reason,
        sessionRef: placeholder.sessionRef,
        acpRunId: placeholder.acpRunId,
        claimedHrcRunId: placeholder.claimedHrcRunId,
      },
    })
  }

  private clearPlaceholderTimers(placeholder: PendingPlaceholder): void {
    clearTimeout(placeholder.pendingTimeout)
    clearTimeout(placeholder.runTimeout)
    if (placeholder.typingTimer) {
      clearInterval(placeholder.typingTimer)
      placeholder.typingTimer = undefined
    }
    if (placeholder.flushTimer) {
      clearTimeout(placeholder.flushTimer)
      placeholder.flushTimer = undefined
    }
    if (placeholder.disableTimer) {
      clearTimeout(placeholder.disableTimer)
      placeholder.disableTimer = undefined
    }
  }

  claimPendingPlaceholder(
    subscription: { sessionRef: string; claimedHrcRunIds: Set<string> },
    event: Parameters<typeof adaptHrcLifecycleEvent>[0] & {
      ts?: string | undefined
      laneRef?: string | undefined
    }
  ): PendingPlaceholder | undefined {
    const hrcRunId = event.runId?.trim()
    const eventSessionRef = canonicalSessionRefFromEvent(event)
    if (!hrcRunId || eventSessionRef !== subscription.sessionRef) {
      return undefined
    }

    const pending = this.pendingPlaceholdersBySessionRef.get(subscription.sessionRef) ?? []
    const placeholder = pending.find(
      (candidate) =>
        candidate.claimedHrcRunId === undefined &&
        this.eventMatchesPendingPlaceholder(candidate, event, hrcRunId) &&
        eventTimestampIsClaimable({
          pendingSince: candidate.pendingSince,
          eventTs: event.ts,
        })
    )
    if (placeholder === undefined) {
      return undefined
    }

    placeholder.claimedHrcRunId = hrcRunId
    subscription.claimedHrcRunIds.add(hrcRunId)
    clearTimeout(placeholder.pendingTimeout)
    log.debug('gw.live_progress.run_claimed', {
      trace: {
        gatewayId: this.options.gatewayId,
        projectId: placeholder.projectId,
        runId: hrcRunId,
      },
      data: {
        sessionRef: subscription.sessionRef,
        acpRunId: placeholder.acpRunId,
      },
    })
    return placeholder
  }

  private eventMatchesPendingPlaceholder(
    placeholder: PendingPlaceholder,
    event: Parameters<typeof adaptHrcLifecycleEvent>[0] & {
      hostSessionId?: string | undefined
      generation?: number | undefined
    },
    hrcRunId: string
  ): boolean {
    if (placeholder.expectedHrcRunId !== undefined) {
      return placeholder.expectedHrcRunId === hrcRunId
    }

    if (placeholder.expectedHostSessionId !== undefined) {
      if (event.hostSessionId !== placeholder.expectedHostSessionId) {
        return false
      }
      return (
        placeholder.expectedGeneration === undefined ||
        event.generation === placeholder.expectedGeneration
      )
    }

    // Once ACP has admitted an input as a concrete run, do not let the
    // placeholder attach to arbitrary later events from an already-active
    // runtime. Queued runs have no HRC correlation yet and will be finalized by
    // the delivery path when their own run completes. A federated interactive
    // signal is the exception: HRC projects the originating ACP run ID into the
    // event, giving us an exact cross-node claim rather than a time heuristic.
    if (placeholder.acpRunId !== undefined) {
      return pickNonEmptyString(asRecord(event.payload), 'acpRunId') === placeholder.acpRunId
    }

    return true
  }

  findPlaceholderByHrcRunId(sessionRef: string, hrcRunId: string): PendingPlaceholder | undefined {
    for (const placeholder of this.placeholdersByRunId.values()) {
      if (placeholder.sessionRef === sessionRef && placeholder.claimedHrcRunId === hrcRunId) {
        return placeholder
      }
    }

    const placeholders = this.pendingPlaceholdersBySessionRef.get(sessionRef) ?? []
    const found = placeholders.find((placeholder) => placeholder.claimedHrcRunId === hrcRunId)
    if (found !== undefined) {
      return found
    }

    return undefined
  }
}
