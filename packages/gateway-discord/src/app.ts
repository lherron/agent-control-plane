import { randomUUID } from 'node:crypto'

import type { WorkClient } from '@wrkq/client'
import type { DeliveryRequest } from 'acp-core'
import type { InterfaceStore } from 'acp-interface-store'
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  Partials,
  type User,
} from 'discord.js'
import { BindingIndex } from './bindings.js'
import {
  DEFAULT_BINDINGS_REFRESH_MS,
  DEFAULT_DELIVERY_IDLE_MS,
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_LEDGER_MAX_DELIVERY_ATTEMPTS,
  DEFAULT_LEDGER_MAX_RATE_LIMIT_ATTEMPTS,
  DEFAULT_MAX_CHARS,
  envNumber,
  optionalEnv,
  requiredEnv,
} from './config.js'
import { JobRunFailureCardLimiter } from './job-runs.js'
import { DiscordLedgerEgress } from './ledger-human-egress.js'
import type { RenderOptions } from './render.js'
import type { DeliveryStreamResponse, DiscordInterfaceBinding } from './types.js'
import { gatewayDiscordFetch } from './user-agent.js'
import { createWebhookManager } from './webhooks.js'

import { GatewayAcpClient } from './acp-client.js'
import { type DashboardSnapshotFetcher, fetchDashboardSnapshotViaWebSocket } from './acp-client.js'
import { DiscordIngress } from './discord-ingress.js'
import { DiscordOutput } from './discord-output.js'
import { log } from './gateway-log.js'
import { LedgerResponses } from './ledger-responses.js'
import { LifecycleCards } from './lifecycle-cards.js'
import { LiveProgress } from './live-progress.js'
import { PendingResponses } from './pending-responses.js'
type FetchLike = typeof fetch
type DiscordReactionUser = User | PartialUser
type DiscordReaction = MessageReaction | PartialMessageReaction
const DEFAULT_LIVE_PROGRESS_TIMEOUT_MS = 60 * 60 * 1000
const TYPING_REFRESH_MS = 8_000
export type GatewayDiscordAppOptions = {
  acpBaseUrl: string
  gatewayId: string
  discordToken?: string | undefined
  client?: Client | undefined
  fetchImpl?: FetchLike | undefined
  dashboardSnapshotImpl?: DashboardSnapshotFetcher | undefined
  maxChars?: number | undefined
  /** Keep the rendered tool-call trace in ledger-routed final reply cards.
   * Defaults on; ACP_DISCORD_RETAIN_TURN_PROGRESS wires the runtime override. */
  retainTurnProgress?: boolean | undefined
  renderOptions?: RenderOptions | undefined
  bindingsRefreshMs?: number | undefined
  deliveryPollMs?: number | undefined
  deliveryIdleMs?: number | undefined
  liveProgressTimeoutMs?: number | undefined
  typingRefreshMs?: number | undefined
  /** When set, post job.dispatched/job.completed lifecycle cards to this fixed
   * Discord channel (the #job-runs egress). Unset disables job-runs cards. */
  jobRunsChannelId?: string | undefined
  jobRunsPollMs?: number | undefined
  /** Bounds failed job.completed cards per job (T-10005); injectable for tests. */
  jobRunFailureCardLimiter?: JobRunFailureCardLimiter | undefined
  /** When set, post wrkq.* / wrkf.* lifecycle cards to this fixed Discord channel
   * (the #work-activity egress, T-05270). Unset disables only those cards; the
   * shared system-events poll loop still runs if jobRunsChannelId is set. */
  workActivityChannelId?: string | undefined
  /** When set, mirror all wrkq room envelopes into this fixed channel root. */
  controlPlaneChannelId?: string | undefined
  maxDeliveryAttempts?: number | undefined
  maxRateLimitAttempts?: number | undefined
  ledgerHumanEgress?:
    | {
        client: WorkClient
        store: InterfaceStore
        closeOnStop?: boolean | undefined
      }
    | undefined
}

export { log } from './gateway-log.js'
export { eventTimestampIsClaimable } from './pending-responses.js'
export { fetchDashboardSnapshotViaWebSocket } from './acp-client.js'
export type { DashboardSnapshotFetcher } from './acp-client.js'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export class GatewayDiscordApp {
  private readonly gatewayId: string
  private readonly client: Client
  private readonly bindingsRefreshMs: number
  private readonly deliveryPollMs: number
  private readonly deliveryIdleMs: number
  private readonly discordToken?: string | undefined
  private readonly bindings = new BindingIndex()
  private readonly createdClient: boolean
  private readonly onMessageCreateBound: (message: Message) => Promise<void>
  private readonly onMessageReactionAddBound: (
    reaction: DiscordReaction,
    user: DiscordReactionUser
  ) => Promise<void>

  private bindingsTimer: ReturnType<typeof setInterval> | undefined
  private deliveryLoopPromise: Promise<void> | undefined
  private deliveryLoopStopped = false
  private deliveryCursor: string | undefined
  private readonly jobRunsChannelId?: string | undefined
  private readonly workActivityChannelId?: string | undefined
  private ledgerHumanEgressLoopPromise: Promise<void> | undefined
  private ledgerHumanEgressLoopStopped = false
  private readonly ledgerHumanEgress?: DiscordLedgerEgress | undefined
  private readonly ledgerHumanEgressResources?:
    | { client: WorkClient; store: InterfaceStore; closeOnStop: boolean }
    | undefined
  private readonly ingress: DiscordIngress
  private readonly pending: PendingResponses
  private readonly live: LiveProgress
  private readonly ledger: LedgerResponses
  private readonly output: DiscordOutput
  private readonly lifecycle: LifecycleCards
  private readonly acp: GatewayAcpClient
  constructor(options: GatewayDiscordAppOptions) {
    const acpBaseUrl = normalizeBaseUrl(options.acpBaseUrl)
    this.gatewayId = options.gatewayId
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
      })
    const fetchImpl = options.fetchImpl ?? gatewayDiscordFetch
    const dashboardSnapshotImpl =
      options.dashboardSnapshotImpl ?? fetchDashboardSnapshotViaWebSocket
    this.acp = new GatewayAcpClient(acpBaseUrl, fetchImpl, dashboardSnapshotImpl)
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
    const retainTurnProgress = options.retainTurnProgress ?? true
    const renderOptions = options.renderOptions ?? {
      useBlockQuotes: process.env['ACP_DISCORD_USE_BLOCKQUOTES'] === '1',
    }
    this.bindingsRefreshMs = options.bindingsRefreshMs ?? DEFAULT_BINDINGS_REFRESH_MS
    this.deliveryPollMs = options.deliveryPollMs ?? DEFAULT_DELIVERY_POLL_MS
    this.deliveryIdleMs = options.deliveryIdleMs ?? DEFAULT_DELIVERY_IDLE_MS
    const liveProgressTimeoutMs = options.liveProgressTimeoutMs ?? DEFAULT_LIVE_PROGRESS_TIMEOUT_MS
    const typingRefreshMs = options.typingRefreshMs ?? TYPING_REFRESH_MS
    this.jobRunsChannelId =
      options.jobRunsChannelId !== undefined && options.jobRunsChannelId.trim().length > 0
        ? options.jobRunsChannelId.trim()
        : undefined
    const jobRunsPollMs = options.jobRunsPollMs ?? this.deliveryPollMs
    const jobRunFailureCardLimiter =
      options.jobRunFailureCardLimiter ?? new JobRunFailureCardLimiter()
    this.workActivityChannelId =
      options.workActivityChannelId !== undefined && options.workActivityChannelId.trim().length > 0
        ? options.workActivityChannelId.trim()
        : undefined
    this.discordToken = options.discordToken
    this.createdClient = options.client === undefined
    const webhooks = createWebhookManager({
      client: this.client as unknown as Parameters<typeof createWebhookManager>[0]['client'],
    })
    const maxRateLimitAttempts =
      options.maxRateLimitAttempts ?? DEFAULT_LEDGER_MAX_RATE_LIMIT_ATTEMPTS
    this.pending = new PendingResponses({
      acp: this.acp,
      client: this.client,
      ensureLiveSubscriptionForSessionRef: (sessionRef, projectId) =>
        this.live.ensureLiveSubscriptionForSessionRef(sessionRef, projectId),
      failPlaceholder: (ui, reason) => this.output.failPlaceholder(ui, reason),
      gatewayId: this.gatewayId,
      liveProgressTimeoutMs: liveProgressTimeoutMs,
      releaseRun: (sessionRef, runId) => this.live.releaseRun(sessionRef, runId),
      retireLedgerInFlight: (inFlight, reason, options) =>
        this.ledger.retireLedgerInFlight(inFlight, reason, options),
      typingRefreshMs: typingRefreshMs,
    })
    this.output = new DiscordOutput({
      acp: this.acp,
      bindings: this.bindings,
      client: this.client,
      gatewayId: this.gatewayId,
      getRunState: (sessionRef, runId) =>
        this.live.sessionEventsManager.getRunState(sessionRef, runId),
      maxChars: maxChars,
      pending: this.pending,
      renderOptions: renderOptions,
      webhooks: webhooks,
    })
    this.live = new LiveProgress({
      acp: this.acp,
      gatewayId: this.gatewayId,
      jobRunsChannelId: this.jobRunsChannelId,
      output: this.output,
      pending: this.pending,
      webhooks: webhooks,
    })
    this.ledger = new LedgerResponses({
      client: this.client,
      gatewayId: this.gatewayId,
      live: this.live,
      liveProgressTimeoutMs: liveProgressTimeoutMs,
      maxChars: maxChars,
      maxRateLimitAttempts: maxRateLimitAttempts,
      output: this.output,
      pending: this.pending,
      renderOptions: renderOptions,
      retainTurnProgress: retainTurnProgress,
      webhooks: webhooks,
    })
    this.lifecycle = new LifecycleCards({
      acp: this.acp,
      deliveryIdleMs: this.deliveryIdleMs,
      gatewayId: this.gatewayId,
      jobRunFailureCardLimiter: jobRunFailureCardLimiter,
      jobRunsChannelId: this.jobRunsChannelId,
      jobRunsPollMs: jobRunsPollMs,
      output: this.output,
      webhooks: webhooks,
      workActivityChannelId: this.workActivityChannelId,
    })
    this.ledgerHumanEgress =
      options.ledgerHumanEgress === undefined
        ? undefined
        : new DiscordLedgerEgress({
            gatewayId: this.gatewayId,
            client: options.ledgerHumanEgress.client,
            store: options.ledgerHumanEgress.store,
            ...(options.controlPlaneChannelId !== undefined &&
            options.controlPlaneChannelId.trim().length > 0
              ? { controlPlaneChannelId: options.controlPlaneChannelId.trim() }
              : {}),
            maxDeliveryAttempts:
              options.maxDeliveryAttempts ?? DEFAULT_LEDGER_MAX_DELIVERY_ATTEMPTS,
            findRecentMessageId: (channelId, envelopeId) =>
              this.ledger.findRecentLedgerMessageId(channelId, envelopeId),
            send: (sink) => this.ledger.sendLedgerEnvelopeSink(sink),
            onHumanDeliveryFailed: (sink, reason) =>
              this.ledger.showLedgerHumanDeliveryFailure(sink, reason),
            onEnvelopeFailed: (envelope) => this.ledger.retireFailedLedgerInFlight(envelope),
          })
    this.ledgerHumanEgressResources =
      options.ledgerHumanEgress === undefined
        ? undefined
        : {
            client: options.ledgerHumanEgress.client,
            store: options.ledgerHumanEgress.store,
            closeOnStop: options.ledgerHumanEgress.closeOnStop === true,
          }
    this.ingress = new DiscordIngress({
      acp: this.acp,
      bindings: this.bindings,
      client: this.client,
      gatewayId: this.gatewayId,
      ledger: this.ledger,
      ledgerHumanEgress: this.ledgerHumanEgress,
      live: this.live,
      output: this.output,
      pending: this.pending,
      refreshBindings: () => this.refreshBindings(),
    })
    this.onMessageCreateBound = async (message) => {
      try {
        await this.handleMessageCreate(message)
      } catch (error) {
        log.error('gw.messageCreate.failed', {
          message: 'handleMessageCreate threw; keeping gateway alive',
          trace: { gatewayId: this.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
    this.onMessageReactionAddBound = async (reaction, user) => {
      try {
        await this.handleMessageReactionAdd(reaction, user)
      } catch (error) {
        log.error('gw.messageReactionAdd.failed', {
          message: 'handleMessageReactionAdd threw; keeping gateway alive',
          trace: { gatewayId: this.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  async start(): Promise<void> {
    await this.refreshBindings()
    this.client.on(Events.MessageCreate, this.onMessageCreateBound)
    this.client.on(Events.MessageReactionAdd, this.onMessageReactionAddBound)

    if (this.createdClient) {
      this.client.once(Events.ClientReady, () => {
        log.info('gw.ready', {
          message: `Discord ready as ${this.client.user?.tag ?? 'unknown'}`,
          trace: { gatewayId: this.gatewayId },
          data: { discordUserTag: this.client.user?.tag },
        })
      })

      const token = this.discordToken ?? requiredEnv('DISCORD_TOKEN', 'DISCORD_BLASTER_TOKEN')
      await this.client.login(token)
    }

    this.bindingsTimer = setInterval(() => {
      void this.refreshBindings().catch((error) => {
        log.warn('gw.bindings.refresh_failed', {
          message: 'Failed to refresh bindings',
          trace: { gatewayId: this.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
    }, this.bindingsRefreshMs)

    this.live.stopped = false
    this.deliveryLoopStopped = false
    this.deliveryLoopPromise = this.runDeliveryLoop()

    if (this.ledgerHumanEgress !== undefined) {
      await this.ledgerHumanEgress.reconcileAttempting()
      await this.ledgerHumanEgress.initializeCursor()
      this.ledgerHumanEgressLoopStopped = false
      this.ledgerHumanEgressLoopPromise = this.runLedgerHumanEgressLoop()
    }

    if (this.jobRunsChannelId !== undefined || this.workActivityChannelId !== undefined) {
      // One global system-events loop feeds every configured lifecycle channel.
      // Prime the cursor to the current tail so a (re)start never floods a channel
      // with historical cards. Best-effort: events that occurred while the gateway
      // was down are skipped.
      this.lifecycle.systemEventsCursor = await this.lifecycle.primeSystemEventsCursor()
      this.lifecycle.systemEventsLoopStopped = false
      this.lifecycle.systemEventsLoopPromise = this.lifecycle.runSystemEventsLoop()
      log.info('gw.system_events.enabled', {
        message: 'system-events lifecycle egress enabled',
        trace: { gatewayId: this.gatewayId },
        data: {
          jobRunsChannelId: this.jobRunsChannelId,
          workActivityChannelId: this.workActivityChannelId,
          fromEventId: this.lifecycle.systemEventsCursor,
        },
      })
    }
  }

  async stop(): Promise<void> {
    this.deliveryLoopStopped = true
    this.lifecycle.systemEventsLoopStopped = true
    this.ledgerHumanEgressLoopStopped = true
    this.live.stopped = true
    this.live.stopAllLiveSubscriptions('app_stop')
    this.pending.clear()
    this.ledger.clear()
    if (this.bindingsTimer) {
      clearInterval(this.bindingsTimer)
      this.bindingsTimer = undefined
    }

    if (this.deliveryLoopPromise) {
      await this.deliveryLoopPromise
      this.deliveryLoopPromise = undefined
    }

    if (this.lifecycle.systemEventsLoopPromise) {
      await this.lifecycle.systemEventsLoopPromise
      this.lifecycle.systemEventsLoopPromise = undefined
    }

    if (this.ledgerHumanEgressLoopPromise) {
      await this.ledgerHumanEgressLoopPromise
      this.ledgerHumanEgressLoopPromise = undefined
    }

    this.client.off(Events.MessageCreate, this.onMessageCreateBound)
    this.client.off(Events.MessageReactionAdd, this.onMessageReactionAddBound)
    if (this.createdClient) {
      this.client.destroy()
    }
    if (this.ledgerHumanEgressResources?.closeOnStop === true) {
      await this.ledgerHumanEgressResources.client.close()
      this.ledgerHumanEgressResources.store.close()
    }
  }

  async refreshBindings(): Promise<DiscordInterfaceBinding[]> {
    const payload = await this.acp.fetchJson<{
      bindings: DiscordInterfaceBinding[]
    }>(`/v1/interface/bindings?gatewayId=${encodeURIComponent(this.gatewayId)}`)
    await this.output.refreshAgentAvatars()
    this.bindings.replaceAll(payload.bindings)
    this.ledgerHumanEgress?.pruneBindings(
      payload.bindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.bindingId)
    )
    await this.live.reconcileLiveSubscriptions(payload.bindings)
    return payload.bindings
  }

  async pollDeliveriesOnce(): Promise<number> {
    const query = this.deliveryCursor ? `?since=${encodeURIComponent(this.deliveryCursor)}` : ''
    const payload = await this.acp.fetchJson<DeliveryStreamResponse>(
      `/v1/gateway/${encodeURIComponent(this.gatewayId)}/deliveries/stream${query}`
    )

    if (payload.nextCursor) {
      this.deliveryCursor = payload.nextCursor
    }

    for (const delivery of payload.deliveries) {
      await this.processDelivery(delivery)
    }

    return payload.deliveries.length
  }

  private async runDeliveryLoop(): Promise<void> {
    while (!this.deliveryLoopStopped) {
      try {
        const count = await this.pollDeliveriesOnce()
        await sleep(count > 0 ? this.deliveryPollMs : this.deliveryIdleMs)
      } catch (error) {
        log.error('gw.deliveries.loop_error', {
          message: 'Delivery loop iteration failed',
          trace: { gatewayId: this.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
        await sleep(this.deliveryIdleMs)
      }
    }
  }

  private async runLedgerHumanEgressLoop(): Promise<void> {
    while (!this.ledgerHumanEgressLoopStopped) {
      try {
        await this.ledgerHumanEgress?.pollOnce()
        await sleep(this.deliveryPollMs)
      } catch (error) {
        log.error('gw.ledger_human_egress.loop_error', {
          message: 'Discord ledger human-egress iteration failed',
          trace: { gatewayId: this.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
        await sleep(this.deliveryIdleMs)
      }
    }
  }

  private async processDelivery(delivery: DeliveryRequest): Promise<void> {
    try {
      await this.output.deliverToDiscord(delivery)
      await this.acp.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/ack`, {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.acp.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/fail`, {
        code: 'discord_delivery_failed',
        message,
      })
      throw error
    }
  }

  handleMessageCreate(message: Message): Promise<void> {
    return this.ingress.handleMessageCreate(message)
  }
  handleMessageReactionAdd(reaction: DiscordReaction, user: DiscordReactionUser): Promise<void> {
    return this.ingress.handleMessageReactionAdd(reaction, user)
  }
  pollSystemEventsOnce(): Promise<number> {
    return this.lifecycle.pollSystemEventsOnce()
  }
}

export async function startGateway(): Promise<void> {
  const app = new GatewayDiscordApp({
    acpBaseUrl: requiredEnv('ACP_BASE_URL', 'CP_URL'),
    gatewayId:
      optionalEnv('ACP_GATEWAY_ID', 'CP_GATEWAY_ID') ?? `discord-${randomUUID().slice(0, 8)}`,
    maxChars: envNumber(['ACP_DISCORD_MAX_CHARS', 'CP_DISCORD_MAX_CHARS'], DEFAULT_MAX_CHARS),
    bindingsRefreshMs: envNumber(
      ['ACP_BINDINGS_REFRESH_MS', 'CP_BINDINGS_REFRESH_MS'],
      DEFAULT_BINDINGS_REFRESH_MS
    ),
    deliveryPollMs: envNumber(
      ['ACP_DELIVERY_POLL_MS', 'CP_DELIVERY_POLL_MS'],
      DEFAULT_DELIVERY_POLL_MS
    ),
    deliveryIdleMs: envNumber(
      ['ACP_DELIVERY_IDLE_MS', 'CP_DELIVERY_IDLE_MS'],
      DEFAULT_DELIVERY_IDLE_MS
    ),
  })

  await app.start()
}
