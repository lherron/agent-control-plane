import type { GatewayAcpClient } from './acp-client.js'
import type { DiscordOutput } from './discord-output.js'
import {
  canonicalSessionRefString,
  projectIdFromScopeRef,
  sessionRefFromBinding,
} from './discord-session-ref.js'
import { log } from './gateway-log.js'
import { adaptHrcLifecycleEvent } from './hrc-event-adapter.js'
import type { PendingResponses } from './pending-responses.js'
import type { PendingPlaceholder } from './pending-responses.js'
import {
  type OnRenderCallback,
  type RunState,
  SessionEventsManager,
} from './session-events-manager.js'
import type { DiscordInterfaceBinding, RenderFrame, UiHandle } from './types.js'
import type { createWebhookManager } from './webhooks.js'

const LIVE_PROGRESS_EDIT_THROTTLE_MS = 1500
const LIVE_PROGRESS_INITIAL_FLUSH_MS = 150
const LIVE_PROGRESS_RATE_LIMIT_BACKOFF_MS = 60_000
const LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS = 1000
const LIVE_SUBSCRIPTION_MAX_RECONNECT_MS = 5000
export type LiveSubscription = {
  sessionRef: string
  projectId: string
  claimedHrcRunIds: Set<string>
  abortController: AbortController
  lastHrcSeq: number
  reconnectDelayMs: number
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export class LiveProgress {
  private readonly liveSubscriptionsBySessionRef = new Map<string, LiveSubscription>()
  private readonly liveSubscriptionPrimesBySessionRef = new Map<string, Promise<void>>()
  private liveSubscriptionPrimeFailureActive = false
  readonly sessionEventsManager: SessionEventsManager
  stopped = false
  constructor(
    private readonly options: {
      acp: Pick<GatewayAcpClient, 'baseUrl' | 'dashboardSnapshot' | 'fetch'>
      gatewayId: string
      jobRunsChannelId: string | undefined
      output: Pick<DiscordOutput, 'editPlaceholderProgress'>
      pending: Pick<PendingResponses, 'claimPendingPlaceholder' | 'findPlaceholderByHrcRunId'>
      webhooks: ReturnType<typeof createWebhookManager>
    }
  ) {
    const renderCallback: OnRenderCallback = (sessionRef, projectId, runId, frame, run) => {
      this.scheduleProgressEdit(sessionRef, projectId, runId, frame, run)
    }
    this.sessionEventsManager = new SessionEventsManager(options.gatewayId, renderCallback)
  }

  releaseRun(sessionRef: string, runId: string): void {
    this.liveSubscriptionsBySessionRef.get(sessionRef)?.claimedHrcRunIds.delete(runId)
  }

  async reconcileLiveSubscriptions(bindings: DiscordInterfaceBinding[]): Promise<void> {
    const desired = new Map<string, { sessionRef: string; projectId: string }>()
    for (const binding of bindings) {
      if (binding.status !== 'active') {
        continue
      }
      const bindingSessionRef = sessionRefFromBinding(binding)
      if (bindingSessionRef === undefined) {
        continue
      }
      const sessionRef = canonicalSessionRefString(bindingSessionRef)
      desired.set(sessionRef, {
        sessionRef,
        projectId: binding.projectId ?? projectIdFromScopeRef(bindingSessionRef.scopeRef),
      })
    }

    for (const sessionRef of [...this.liveSubscriptionsBySessionRef.keys()]) {
      if (!desired.has(sessionRef)) {
        this.stopLiveSubscription(sessionRef, 'binding_removed')
      }
    }

    const additions = [...desired.values()].filter(
      (entry) => !this.liveSubscriptionsBySessionRef.has(entry.sessionRef)
    )
    if (additions.length === 0) {
      return
    }

    const lastHrcSeq = await this.primeLiveSubscriptionsCursor()
    if (lastHrcSeq === undefined) {
      return
    }
    for (const entry of additions) {
      this.startLiveSubscription(entry, lastHrcSeq)
    }
  }

  private async primeLiveSubscriptionsCursor(): Promise<number | undefined> {
    try {
      const snapshot = await this.options.acp.dashboardSnapshot(this.options.acp.baseUrl)
      const lastHrcSeq = snapshot.cursors?.lastHrcSeq
      if (typeof lastHrcSeq !== 'number' || !Number.isFinite(lastHrcSeq) || lastHrcSeq < 0) {
        throw new Error('dashboard snapshot did not include a valid lastHrcSeq cursor')
      }
      if (this.liveSubscriptionPrimeFailureActive) {
        this.liveSubscriptionPrimeFailureActive = false
        log.info('gw.live_progress.prime_recovered', {
          message: 'Live-progress cursor priming recovered',
          trace: { gatewayId: this.options.gatewayId },
        })
      }
      return Math.floor(lastHrcSeq)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('gw.live_progress.prime_failed', {
        message: 'Failed to prime live-progress subscriptions; retrying on binding refresh',
        trace: { gatewayId: this.options.gatewayId },
        err: { message },
      })
      if (!this.liveSubscriptionPrimeFailureActive) {
        this.liveSubscriptionPrimeFailureActive = true
        await this.alertLiveSubscriptionPrimeFailure(message)
      }
      return undefined
    }
  }

  private async alertLiveSubscriptionPrimeFailure(reason: string): Promise<void> {
    if (this.options.jobRunsChannelId === undefined) {
      log.error('gw.live_progress.alert_unavailable', {
        message: 'Cannot post live-progress failure alert because job-runs channel is unset',
        trace: { gatewayId: this.options.gatewayId },
      })
      return
    }

    try {
      await this.options.webhooks.send(this.options.jobRunsChannelId, {
        content: [
          '🚨 **Gateway live progress disabled**',
          `Gateway: \`${this.options.gatewayId}\``,
          `Reason: ${reason.slice(0, 500)}`,
          'No new live-progress subscriptions were started. Cursor priming will keep retrying.',
        ].join('\n'),
      })
      log.info('gw.live_progress.alert_sent', {
        message: 'Posted live-progress failure alert to Discord',
        trace: { gatewayId: this.options.gatewayId },
        data: { channelId: this.options.jobRunsChannelId },
      })
    } catch (error) {
      log.error('gw.live_progress.alert_failed', {
        message: 'Failed to post live-progress failure alert to Discord',
        trace: { gatewayId: this.options.gatewayId },
        data: { channelId: this.options.jobRunsChannelId },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private startLiveSubscription(
    input: { sessionRef: string; projectId: string },
    lastHrcSeq: number
  ): void {
    this.stopLiveSubscription(input.sessionRef, 'replaced')

    const subscription: LiveSubscription = {
      sessionRef: input.sessionRef,
      projectId: input.projectId,
      claimedHrcRunIds: new Set(),
      abortController: new AbortController(),
      lastHrcSeq,
      reconnectDelayMs: LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS,
    }

    this.liveSubscriptionsBySessionRef.set(input.sessionRef, subscription)
    this.sessionEventsManager.subscribe(input.sessionRef, input.projectId)
    log.info('gw.live_progress.subscription_started', {
      message: 'Started live-progress subscription',
      trace: { gatewayId: this.options.gatewayId, projectId: input.projectId },
      data: { sessionRef: input.sessionRef, fromSeq: lastHrcSeq + 1 || 1 },
    })
    void this.runLiveSubscription(subscription)
  }

  private async runLiveSubscription(subscription: LiveSubscription): Promise<void> {
    while (!subscription.abortController.signal.aborted) {
      let reader:
        | {
            read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
            releaseLock(): void
          }
        | undefined
      try {
        const url = new URL(`${this.options.acp.baseUrl}/v1/session-refs/events`)
        url.searchParams.set('sessionRef', subscription.sessionRef)
        url.searchParams.set('follow', 'true')
        url.searchParams.set('fromSeq', String(subscription.lastHrcSeq + 1 || 1))

        log.debug('gw.live_progress.subscribe', {
          trace: {
            gatewayId: this.options.gatewayId,
            projectId: subscription.projectId,
          },
          data: {
            sessionRef: subscription.sessionRef,
            fromSeq: subscription.lastHrcSeq + 1 || 1,
          },
        })

        const response = await this.options.acp.fetch(url, {
          headers: { accept: 'application/x-ndjson' },
          signal: subscription.abortController.signal,
        })
        if (!response.ok) {
          throw new Error(
            `Live event subscription failed: ${response.status} ${await response.text()}`
          )
        }
        if (!response.body) {
          throw new Error('Live event subscription response did not include a body')
        }

        subscription.reconnectDelayMs = LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS
        const decoder = new TextDecoder()
        const streamReader = response.body.getReader() as {
          read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
          releaseLock(): void
        }
        reader = streamReader
        let buffer = ''
        for (;;) {
          const { done, value } = await streamReader.read()
          if (done) {
            break
          }
          buffer += decoder.decode(value, { stream: true })
          buffer = this.processLiveEventBuffer(buffer, subscription)
        }

        buffer += decoder.decode()
        this.processLiveEventBuffer(`${buffer}\n`, subscription)
        throw new Error('Live event subscription stream closed')
      } catch (error) {
        if (!subscription.abortController.signal.aborted) {
          log.warn('gw.live_progress.subscription_reconnect', {
            message: 'Live progress subscription will reconnect',
            trace: {
              gatewayId: this.options.gatewayId,
              projectId: subscription.projectId,
            },
            data: {
              sessionRef: subscription.sessionRef,
              nextFromSeq: subscription.lastHrcSeq + 1,
              backoffMs: subscription.reconnectDelayMs,
            },
            err: {
              message: error instanceof Error ? error.message : String(error),
            },
          })
          await sleep(subscription.reconnectDelayMs)
          subscription.reconnectDelayMs = Math.min(
            subscription.reconnectDelayMs * 2,
            LIVE_SUBSCRIPTION_MAX_RECONNECT_MS
          )
        }
      } finally {
        try {
          reader?.releaseLock()
        } catch {
          // best-effort cleanup only
        }
      }
    }
  }

  private processLiveEventBuffer(buffer: string, subscription: LiveSubscription): string {
    const lines = buffer.split(/\r?\n/)
    const remainder = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      this.processLiveEventLine(trimmed, subscription)
    }
    return remainder
  }

  private processLiveEventLine(line: string, subscription: LiveSubscription): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      log.warn('gw.live_progress.event_parse_failed', {
        message: 'Failed to parse live progress event',
        trace: {
          gatewayId: this.options.gatewayId,
          projectId: subscription.projectId,
          sessionRef: subscription.sessionRef,
        },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }

    const event = parsed as Parameters<typeof adaptHrcLifecycleEvent>[0] & {
      ts?: string | undefined
      laneRef?: string | undefined
    }
    if (typeof event.hrcSeq === 'number' && event.hrcSeq > subscription.lastHrcSeq) {
      subscription.lastHrcSeq = event.hrcSeq
    }

    const hrcRunId = event.runId?.trim()
    if (!hrcRunId) {
      return
    }

    if (!subscription.claimedHrcRunIds.has(hrcRunId)) {
      const claimed = this.options.pending.claimPendingPlaceholder(subscription, event)
      if (!claimed) {
        return
      }
    }

    const envelope = adaptHrcLifecycleEvent(event)
    if (!envelope) {
      return
    }

    this.sessionEventsManager.receive(envelope)
    if (
      envelope.event.type === 'tool_execution_start' &&
      envelope.event.toolName === 'AskUserQuestion'
    ) {
      const placeholder = this.options.pending.findPlaceholderByHrcRunId(
        envelope.sessionRef,
        hrcRunId
      )
      if (placeholder?.typingTimer) {
        clearInterval(placeholder.typingTimer)
        placeholder.typingTimer = undefined
      }
      if (placeholder?.flushTimer) {
        clearTimeout(placeholder.flushTimer)
        placeholder.flushTimer = undefined
      }
      void this.flushProgressEdit(envelope.sessionRef, hrcRunId)
    }
    if (envelope.event.type === 'turn_end') {
      const placeholder = this.options.pending.findPlaceholderByHrcRunId(
        envelope.sessionRef,
        hrcRunId
      )
      if (placeholder?.runTimeout) {
        clearTimeout(placeholder.runTimeout)
      }
      // Stop the Discord typing indicator the moment HRC signals turn_end,
      // not when the polling-driven final delivery arrives. The polling gap
      // (deliveryPollMs) was leaving "<bot> is typing..." up after the
      // assistant text was already visible.
      if (placeholder?.typingTimer) {
        clearInterval(placeholder.typingTimer)
        placeholder.typingTimer = undefined
      }
    }
  }

  private scheduleProgressEdit(
    sessionRef: string,
    projectId: string,
    runId: string,
    frame: RenderFrame,
    run: RunState
  ): void {
    const placeholder = this.options.pending.findPlaceholderByHrcRunId(sessionRef, runId)
    if (!placeholder || placeholder.projectId !== projectId || placeholder.webhookGone) {
      return
    }

    placeholder.pendingFrame = {
      ...frame,
      title: placeholder.promptPreview || frame.title,
    }
    placeholder.pendingRun = run
    if (placeholder.editDisabled) {
      return
    }

    if (placeholder.flushTimer) {
      clearTimeout(placeholder.flushTimer)
    }
    const now = Date.now()
    const delay =
      placeholder.lastSuccessfulEditAt === 0
        ? LIVE_PROGRESS_INITIAL_FLUSH_MS
        : Math.max(LIVE_PROGRESS_EDIT_THROTTLE_MS - (now - placeholder.lastSuccessfulEditAt), 0)
    placeholder.flushTimer = setTimeout(() => {
      placeholder.flushTimer = undefined
      void this.flushProgressEdit(sessionRef, runId)
    }, delay)
  }

  private async flushProgressEdit(sessionRef: string, runId: string): Promise<void> {
    const placeholder = this.options.pending.findPlaceholderByHrcRunId(sessionRef, runId)
    if (
      !placeholder ||
      !placeholder.ui.channelId ||
      !placeholder.ui.webhookId ||
      placeholder.editDisabled ||
      placeholder.webhookGone ||
      !placeholder.pendingFrame
    ) {
      return
    }

    const identity = placeholder.identity
    if (!identity) {
      return
    }

    const result = await this.options.output.editPlaceholderProgress(
      placeholder.ui as UiHandle & { kind: 'message'; webhookId: string },
      placeholder.pendingFrame,
      identity
    )

    if (result.ok) {
      placeholder.lastSuccessfulEditAt = Date.now()
      placeholder.pendingFrame = undefined
      placeholder.pendingRun = undefined
      return
    }

    if (result.rateLimited) {
      this.disableProgressEditsTemporarily(placeholder)
    } else if (result.webhookGone) {
      placeholder.webhookGone = true
      placeholder.editDisabled = true
      if (placeholder.flushTimer) {
        clearTimeout(placeholder.flushTimer)
        placeholder.flushTimer = undefined
      }
    }
  }

  private disableProgressEditsTemporarily(placeholder: PendingPlaceholder): void {
    placeholder.editDisabled = true
    if (placeholder.flushTimer) {
      clearTimeout(placeholder.flushTimer)
      placeholder.flushTimer = undefined
    }
    if (placeholder.disableTimer) {
      clearTimeout(placeholder.disableTimer)
    }
    placeholder.disableTimer = setTimeout(() => {
      placeholder.disableTimer = undefined
      placeholder.editDisabled = false
      if (placeholder.pendingFrame && !placeholder.webhookGone && placeholder.claimedHrcRunId) {
        this.scheduleProgressEdit(
          placeholder.sessionRef,
          placeholder.projectId,
          placeholder.claimedHrcRunId,
          placeholder.pendingFrame,
          placeholder.pendingRun ??
            ({
              runId: placeholder.claimedHrcRunId,
              projectId: placeholder.projectId,
            } as RunState)
        )
      }
    }, LIVE_PROGRESS_RATE_LIMIT_BACKOFF_MS)
  }

  private stopLiveSubscription(sessionRef: string, reason: string): void {
    const subscription = this.liveSubscriptionsBySessionRef.get(sessionRef)
    if (!subscription) {
      return
    }
    log.debug('gw.live_progress.stop', {
      trace: {
        gatewayId: this.options.gatewayId,
        projectId: subscription.projectId,
      },
      data: { reason, sessionRef },
    })
    this.clearLiveSubscription(subscription)
    this.liveSubscriptionsBySessionRef.delete(sessionRef)
    this.sessionEventsManager.unsubscribe(sessionRef)
  }

  stopAllLiveSubscriptions(reason: string): void {
    for (const sessionRef of [...this.liveSubscriptionsBySessionRef.keys()]) {
      this.stopLiveSubscription(sessionRef, reason)
    }
  }

  private clearLiveSubscription(subscription: LiveSubscription): void {
    if (!subscription.abortController.signal.aborted) {
      subscription.abortController.abort()
    }
  }

  ensureLiveSubscriptionForSessionRef(sessionRef: string, projectId: string): void {
    if (
      this.liveSubscriptionsBySessionRef.has(sessionRef) ||
      this.liveSubscriptionPrimesBySessionRef.has(sessionRef)
    ) {
      return
    }

    const pending = (async () => {
      const lastHrcSeq = await this.primeLiveSubscriptionsCursor()
      if (
        lastHrcSeq !== undefined &&
        !this.stopped &&
        !this.liveSubscriptionsBySessionRef.has(sessionRef)
      ) {
        this.startLiveSubscription({ sessionRef, projectId }, lastHrcSeq)
      }
    })().finally(() => {
      this.liveSubscriptionPrimesBySessionRef.delete(sessionRef)
    })
    this.liveSubscriptionPrimesBySessionRef.set(sessionRef, pending)
  }
}
