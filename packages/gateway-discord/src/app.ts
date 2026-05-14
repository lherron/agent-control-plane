import { randomUUID } from 'node:crypto'

import type { DeliveryRequest, InputIntent, InterfaceSessionRef } from 'acp-core'
import { parseScopeRef, validateScopeRef } from 'agent-scope'
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  MessageType,
  type PartialMessageReaction,
  type PartialUser,
  Partials,
  type User,
} from 'discord.js'

import { mapDiscordMessageAttachments, resolveDiscordIngressContent } from './attachment-ingress.js'
import { createDiscordAttachments, fetchMediaAttachments } from './attachments.js'
import {
  BindingIndex,
  conversationRefToChannelId,
  threadRefToThreadId,
  toConversationRefs,
} from './bindings.js'
import {
  DEFAULT_BINDINGS_REFRESH_MS,
  DEFAULT_DELIVERY_IDLE_MS,
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_MAX_CHARS,
  envNumber,
  optionalEnv,
  requiredEnv,
} from './config.js'
import { classifyDiscordError } from './discord-errors.js'
import { adaptHrcLifecycleEvent, canonicalSessionRefFromEvent } from './hrc-event-adapter.js'
import {
  type DiscordAgentMessageIdentity,
  avatarFor,
  formatSessionSubtext,
  identityFromSessionRef,
} from './identity.js'
import {
  type KeywordRoute,
  buildDiscordThreadLaneRef,
  buildDiscordThreadName,
  parseDiscordKeyword,
} from './keywords.js'
import { createLogger } from './logger.js'
import { type RenderOptions, extractImagesFromFrame, extractMediaRefsFromFrame } from './render.js'
import { type RunState, SessionEventsManager } from './session-events-manager.js'
import type {
  DeliveryStreamResponse,
  DiscordInterfaceBinding,
  RenderFrame,
  UiHandle,
} from './types.js'
import { createWebhookManager } from './webhooks.js'
import {
  type FinalDeliveryWritePlan,
  buildProgressEditContent,
  planFinalDeliveryWrite,
} from './write-plan.js'

const VIRTU_BOT_ID = optionalEnv('DISCORD_VIRTU_BOT_ID') ?? '1165644636807778414'

const MAX_INGRESS_FAILURE_REASON_CHARS = 400
const LIVE_PROGRESS_EDIT_THROTTLE_MS = 1500
const LIVE_PROGRESS_INITIAL_FLUSH_MS = 150
const LIVE_PROGRESS_RATE_LIMIT_BACKOFF_MS = 60_000
const DEFAULT_LIVE_PROGRESS_TIMEOUT_MS = 60 * 60 * 1000
const PENDING_PLACEHOLDER_TIMEOUT_MS = 300_000
const LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS = 1000
const LIVE_SUBSCRIPTION_MAX_RECONNECT_MS = 5000
// Discord's native typing indicator lasts ~10s per ping. Refresh every 8s so
// the "<bot> is typing..." UX stays visible the whole time a request is in
// flight without sending edits to the placeholder bubble.
const TYPING_REFRESH_MS = 8_000
const CANCEL_REACTION_NAMES = new Set(['x', 'cancel', '❌', '✖', '✕', '✖️'])

/**
 * Pull a human-readable cause out of the ACP error envelope so we can show it
 * to the Discord user. The server returns
 *   {"error":{"code":"...","message":"...","details":{"cause":"..."}}}
 * Prefer `details.cause` (most specific), fall back to `error.message`. If the
 * body isn't JSON or doesn't fit the shape, return the raw text trimmed so we
 * never surface nothing.
 */
function extractIngressFailureReason(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return truncateReason(trimmed)
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const err = (parsed as { error?: unknown }).error
    if (typeof err === 'object' && err !== null) {
      const details = (err as { details?: unknown }).details
      if (typeof details === 'object' && details !== null) {
        const cause = (details as { cause?: unknown }).cause
        if (typeof cause === 'string' && cause.trim()) {
          return truncateReason(cause.trim())
        }
      }
      const message = (err as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) {
        return truncateReason(message.trim())
      }
    }
  }
  return truncateReason(trimmed)
}

function truncateReason(reason: string): string {
  if (reason.length <= MAX_INGRESS_FAILURE_REASON_CHARS) return reason
  return `${reason.slice(0, MAX_INGRESS_FAILURE_REASON_CHARS - 1)}…`
}

function resolveMessageIdentity(sessionRef: InterfaceSessionRef): DiscordAgentMessageIdentity {
  const identity = identityFromSessionRef(sessionRef)
  return {
    agentId: identity.agentId,
    subtext: formatSessionSubtext(sessionRef),
    avatarUrl: avatarFor(identity.agentId),
  }
}

function projectIdFromScopeRef(scopeRef: string): string {
  // Use the canonical agent-scope parser. Falls back to the raw scopeRef
  // when the input isn't a well-formed scope or lacks a project segment —
  // intended only for logging/diagnostic contexts. Healthy code paths
  // should prefer `binding.projectId` directly (always populated since
  // the projectId-required validation landed).
  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    return scopeRef
  }
  return parseScopeRef(scopeRef).projectId ?? scopeRef
}

function laneIdFromRef(laneRef: string): string {
  return laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
}

function isCancelReactionName(name: string | null): boolean {
  if (name === null) {
    return false
  }
  const normalized = name.trim().toLowerCase()
  return (
    CANCEL_REACTION_NAMES.has(normalized) ||
    CANCEL_REACTION_NAMES.has(stripVariationSelector(normalized))
  )
}

function stripVariationSelector(value: string): string {
  return value.replace(/\uFE0F/g, '')
}

function canonicalSessionRefString(sessionRef: InterfaceSessionRef): string {
  return `${sessionRef.scopeRef}/lane:${laneIdFromRef(sessionRef.laneRef)}`
}

function sessionRefFromBinding(binding: DiscordInterfaceBinding): InterfaceSessionRef | undefined {
  if (binding.sessionRef !== undefined) {
    return binding.sessionRef
  }

  const legacy = binding as DiscordInterfaceBinding & {
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }
  if (legacy.scopeRef !== undefined && legacy.laneRef !== undefined) {
    return { scopeRef: legacy.scopeRef, laneRef: legacy.laneRef }
  }

  return undefined
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

function errorField(error: unknown, key: 'status' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined
}

function isDiscordRateLimit(error: unknown): boolean {
  return errorField(error, 'status') === 429 || errorField(error, 'code') === 429
}

function isDiscordWebhookGone(error: unknown): boolean {
  const status = errorField(error, 'status')
  const code = errorField(error, 'code')
  if (status === 404 || code === 404) {
    return true
  }
  return error instanceof Error && /webhook .*not found|was not found/i.test(error.message)
}

type FetchLike = typeof fetch

type PendingPlaceholder = {
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
}

type LiveSubscription = {
  sessionRef: string
  projectId: string
  claimedHrcRunIds: Set<string>
  abortController: AbortController
  lastHrcSeq: number
  reconnectDelayMs: number
}

type DiscordReactionUser = User | PartialUser
type DiscordReaction = MessageReaction | PartialMessageReaction

type IngressRoute = KeywordRoute

type InterfaceMessageResponse = {
  inputAttemptId: string
  runId?: string | undefined
  targetRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  admission?: {
    kind?: string | undefined
  }
  currentState?: Record<string, unknown> | undefined
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

type MobileSessionSummary = {
  sessionRef?: string | undefined
  status?: string | undefined
  activeTurnId?: string | undefined
  capabilities?: {
    input?: boolean | undefined
  }
}

type MobileSessionsResponse = {
  sessions?: MobileSessionSummary[] | undefined
}

export type GatewayDiscordAppOptions = {
  acpBaseUrl: string
  gatewayId: string
  discordToken?: string | undefined
  client?: Client | undefined
  fetchImpl?: FetchLike | undefined
  maxChars?: number | undefined
  renderOptions?: RenderOptions | undefined
  bindingsRefreshMs?: number | undefined
  deliveryPollMs?: number | undefined
  deliveryIdleMs?: number | undefined
  liveProgressTimeoutMs?: number | undefined
}

export const log = createLogger({ component: 'gateway-discord' })

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export class GatewayDiscordApp {
  private readonly acpBaseUrl: string
  private readonly gatewayId: string
  private readonly client: Client
  private readonly fetchImpl: FetchLike
  private readonly maxChars: number
  private readonly renderOptions: RenderOptions
  private readonly bindingsRefreshMs: number
  private readonly deliveryPollMs: number
  private readonly deliveryIdleMs: number
  private readonly liveProgressTimeoutMs: number
  private readonly discordToken?: string | undefined
  private readonly bindings = new BindingIndex()
  private readonly placeholdersByRunId = new Map<string, PendingPlaceholder>()
  private readonly liveSubscriptionsBySessionRef = new Map<string, LiveSubscription>()
  private readonly pendingPlaceholdersBySessionRef = new Map<string, PendingPlaceholder[]>()
  private readonly sessionEventsManager: SessionEventsManager
  private readonly keywordRoutesByMessageId = new Map<string, IngressRoute>()
  private readonly activePlaceholdersByMessageId = new Map<string, PendingPlaceholder>()
  private readonly createdClient: boolean
  private readonly onMessageCreateBound: (message: Message) => Promise<void>
  private readonly onMessageReactionAddBound: (
    reaction: DiscordReaction,
    user: DiscordReactionUser
  ) => Promise<void>
  private readonly webhooks: ReturnType<typeof createWebhookManager>

  private bindingsTimer: ReturnType<typeof setInterval> | undefined
  private deliveryLoopPromise: Promise<void> | undefined
  private deliveryLoopStopped = false
  private deliveryCursor: string | undefined

  constructor(options: GatewayDiscordAppOptions) {
    this.acpBaseUrl = normalizeBaseUrl(options.acpBaseUrl)
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
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
    this.renderOptions = options.renderOptions ?? {
      useBlockQuotes: process.env['ACP_DISCORD_USE_BLOCKQUOTES'] === '1',
    }
    this.bindingsRefreshMs = options.bindingsRefreshMs ?? DEFAULT_BINDINGS_REFRESH_MS
    this.deliveryPollMs = options.deliveryPollMs ?? DEFAULT_DELIVERY_POLL_MS
    this.deliveryIdleMs = options.deliveryIdleMs ?? DEFAULT_DELIVERY_IDLE_MS
    this.liveProgressTimeoutMs = options.liveProgressTimeoutMs ?? DEFAULT_LIVE_PROGRESS_TIMEOUT_MS
    this.discordToken = options.discordToken
    this.createdClient = options.client === undefined
    this.webhooks = createWebhookManager({
      client: this.client as unknown as Parameters<typeof createWebhookManager>[0]['client'],
    })
    this.sessionEventsManager = new SessionEventsManager(
      this.gatewayId,
      (sessionRef, projectId, runId, frame, run) => {
        this.scheduleProgressEdit(sessionRef, projectId, runId, frame, run)
      }
    )
    this.onMessageCreateBound = async (message) => {
      try {
        await this.handleMessageCreate(message)
      } catch (error) {
        log.error('gw.messageCreate.failed', {
          message: 'handleMessageCreate threw; keeping gateway alive',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
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
          err: { message: error instanceof Error ? error.message : String(error) },
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
          err: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    }, this.bindingsRefreshMs)

    this.deliveryLoopStopped = false
    this.deliveryLoopPromise = this.runDeliveryLoop()
  }

  async stop(): Promise<void> {
    this.deliveryLoopStopped = true
    this.stopAllLiveSubscriptions('app_stop')
    for (const placeholder of this.placeholdersByRunId.values()) {
      this.clearPlaceholderTimers(placeholder)
    }
    for (const placeholders of this.pendingPlaceholdersBySessionRef.values()) {
      for (const placeholder of placeholders) {
        this.clearPlaceholderTimers(placeholder)
      }
    }
    this.placeholdersByRunId.clear()
    this.pendingPlaceholdersBySessionRef.clear()
    this.activePlaceholdersByMessageId.clear()
    if (this.bindingsTimer) {
      clearInterval(this.bindingsTimer)
      this.bindingsTimer = undefined
    }

    if (this.deliveryLoopPromise) {
      await this.deliveryLoopPromise
      this.deliveryLoopPromise = undefined
    }

    this.client.off(Events.MessageCreate, this.onMessageCreateBound)
    this.client.off(Events.MessageReactionAdd, this.onMessageReactionAddBound)
    if (this.createdClient) {
      this.client.destroy()
    }
  }

  async handleMessageReactionAdd(
    reaction: DiscordReaction,
    user: DiscordReactionUser
  ): Promise<void> {
    const actor = await this.resolveReactionUser(user)
    if (actor === undefined) {
      return
    }
    if (actor.bot && actor.id !== VIRTU_BOT_ID) {
      return
    }

    const resolvedReaction = await this.resolveReaction(reaction)
    if (resolvedReaction === undefined || !isCancelReactionName(resolvedReaction.emoji.name)) {
      return
    }

    const placeholder = this.activePlaceholdersByMessageId.get(resolvedReaction.message.id)
    if (placeholder === undefined) {
      return
    }

    if (placeholder.acpRunId === undefined) {
      placeholder.cancelRequested = true
      placeholder.cancelActorId = actor?.id
      log.info('gw.discord.cancel_reaction.deferred', {
        message: 'Cancel reaction recorded before ACP run id was available',
        trace: { gatewayId: this.gatewayId, projectId: placeholder.projectId },
        data: { messageId: placeholder.ui.id, sessionRef: placeholder.sessionRef },
      })
      return
    }

    await this.cancelPlaceholderRun(placeholder, actor?.id)
  }

  async refreshBindings(): Promise<DiscordInterfaceBinding[]> {
    const payload = await this.fetchJson<{ bindings: DiscordInterfaceBinding[] }>(
      `/v1/interface/bindings?gatewayId=${encodeURIComponent(this.gatewayId)}`
    )
    this.bindings.replaceAll(payload.bindings)
    this.reconcileLiveSubscriptions(payload.bindings)
    return payload.bindings
  }

  async pollDeliveriesOnce(): Promise<number> {
    const query = this.deliveryCursor ? `?since=${encodeURIComponent(this.deliveryCursor)}` : ''
    const payload = await this.fetchJson<DeliveryStreamResponse>(
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

  async handleMessageCreate(message: Message): Promise<void> {
    if (!message.guildId) {
      return
    }

    if (
      message.type === MessageType.ThreadCreated ||
      message.type === MessageType.ThreadStarterMessage
    ) {
      return
    }

    if (message.author.bot) {
      if (message.author.id === VIRTU_BOT_ID) {
        // test bot allowed through
      } else if (message.author.id === this.client.user?.id) {
        return
      } else {
        return
      }
    }

    const conversation = toConversationRefs({
      channelId: message.channel.isThread()
        ? (message.channel.parentId ?? message.channelId)
        : message.channelId,
      ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
    })

    let binding = this.bindings.getBindingFor(conversation)
    if (!binding) {
      await this.refreshBindings()
      binding = this.bindings.getBindingFor(conversation)
    }
    if (binding && conversation.threadRef !== undefined && binding.threadRef === undefined) {
      await this.refreshBindings()
      binding = this.bindings.getBindingFor(conversation)
    }

    if (!binding) {
      return
    }

    const route = await this.resolveIngressRoute(message, binding, conversation)
    if (route === undefined) {
      return
    }

    const routeBinding =
      route.conversation.threadRef !== undefined
        ? (this.bindings.getBindingFor(route.conversation) ?? binding)
        : binding
    const bindingSessionRef = sessionRefFromBinding(routeBinding)
    if (bindingSessionRef === undefined) {
      await message.reply('The bound project is missing a session reference.')
      return
    }

    const ingressContent = route.content

    // Exact thread bindings own their sessionRef. Parent fallback threads keep
    // the historical synthetic Discord lane so independent thread work does
    // not collapse into the parent channel lane.
    const hasExactThreadBinding =
      route.conversation.threadRef !== undefined && routeBinding.threadRef !== undefined
    const effectiveSessionRef: InterfaceSessionRef =
      route.targetThreadId !== undefined && !hasExactThreadBinding
        ? {
            scopeRef: bindingSessionRef.scopeRef,
            laneRef: buildDiscordThreadLaneRef(route.targetThreadId),
          }
        : bindingSessionRef

    const placeholder = await this.createPlaceholder({
      message,
      channelId: route.targetChannelId,
      content: ingressContent,
      ...(route.targetThreadId !== undefined ? { threadId: route.targetThreadId } : {}),
      sessionRef: effectiveSessionRef,
    })
    const pendingPlaceholder =
      placeholder !== undefined
        ? this.registerPendingPlaceholder({
            placeholder,
            sessionRef: effectiveSessionRef,
            projectId:
              routeBinding.projectId ?? projectIdFromScopeRef(effectiveSessionRef.scopeRef),
            promptPreview:
              ingressContent.length > 100 ? `${ingressContent.slice(0, 100)}…` : ingressContent,
          })
        : undefined
    const attachments = mapDiscordMessageAttachments(message)
    let response: Response
    try {
      const shouldSteer = await this.shouldSteerInput(effectiveSessionRef)
      const intent: InputIntent | undefined = shouldSteer
        ? {
            kind: 'contribute_to_active_run',
            fallback: 'queue',
            contributionSemantics: 'interrupt_and_continue',
          }
        : undefined

      response = await this.fetchImpl(`${this.acpBaseUrl}/v1/interface/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: `discord:message:${message.id}`,
          source: {
            gatewayId: this.gatewayId,
            conversationRef: route.conversation.conversationRef,
            ...(route.conversation.threadRef ? { threadRef: route.conversation.threadRef } : {}),
            messageRef: `discord:message:${message.id}`,
            authorRef: `discord:user:${message.author.id}`,
          },
          content: ingressContent,
          ...(intent !== undefined ? { intent } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      })
    } catch (error) {
      // Thrown fetch (network error, socket refused, timeout) never reaches the
      // `!response.ok` branch, so the placeholder would otherwise stay as a
      // stale `⏳ Processing` forever. Replace it with a visible error frame so
      // the user sees the failure at the same location they were watching.
      const reason = error instanceof Error ? error.message : String(error)
      if (pendingPlaceholder) {
        this.removePendingPlaceholder(pendingPlaceholder, 'post_failed')
      }
      if (placeholder) {
        await this.failPlaceholder(placeholder, `Could not reach ACP: ${reason}`)
      }
      throw error
    }

    if (!response.ok) {
      const rawBody = await response.text()
      const reason = extractIngressFailureReason(rawBody) ?? `HTTP ${response.status}`
      if (pendingPlaceholder) {
        this.removePendingPlaceholder(pendingPlaceholder, 'post_failed')
      }
      if (placeholder) {
        await this.failPlaceholder(placeholder, `Agent invocation failed: ${reason}`)
      } else {
        await this.replyIngressFailure(message, `Agent invocation failed: ${reason}`)
      }
      throw new Error(`Interface ingress failed: ${response.status} ${rawBody}`)
    }

    const payload = (await response.json()) as InterfaceMessageResponse
    if (pendingPlaceholder) {
      if (payload.runId !== undefined) {
        pendingPlaceholder.acpRunId = payload.runId
        await this.refreshPendingPlaceholderCorrelation(pendingPlaceholder)
        this.placeholdersByRunId.set(payload.runId, pendingPlaceholder)
        if (pendingPlaceholder.cancelRequested === true) {
          await this.cancelPlaceholderRun(pendingPlaceholder, pendingPlaceholder.cancelActorId)
        }
      } else if (
        payload.admission?.kind === 'accepted_in_flight' ||
        payload.admission?.kind === 'admission_pending'
      ) {
        this.removePendingPlaceholder(pendingPlaceholder, payload.admission.kind)
        await this.noticePlaceholder(
          pendingPlaceholder.ui,
          payload.admission.kind === 'accepted_in_flight'
            ? `↪️ **Steered active run:** ${pendingPlaceholder.promptPreview ?? 'Input accepted'}`
            : `⏳ **Steering pending:** ${pendingPlaceholder.promptPreview ?? 'Input pending'}`
        )
      } else if (payload.admission?.kind === 'rejected') {
        this.removePendingPlaceholder(pendingPlaceholder, 'admission_rejected')
        await this.failPlaceholder(
          pendingPlaceholder.ui,
          String(payload.currentState?.['reason'] ?? 'Input was rejected')
        )
      }
    }
  }

  private async shouldSteerInput(sessionRef: InterfaceSessionRef): Promise<boolean> {
    return this.resolveSteeringAvailability(sessionRef)
  }

  private async resolveReaction(reaction: DiscordReaction): Promise<MessageReaction | undefined> {
    if (
      reaction.partial === true &&
      typeof (reaction as { fetch?: unknown }).fetch === 'function'
    ) {
      try {
        return await reaction.fetch()
      } catch (error) {
        log.warn('gw.discord.reaction.fetch_failed', {
          message: 'Could not fetch partial Discord reaction',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        return undefined
      }
    }

    return reaction as MessageReaction
  }

  private async resolveReactionUser(user: DiscordReactionUser): Promise<User | undefined> {
    if (user.partial === true && typeof (user as { fetch?: unknown }).fetch === 'function') {
      try {
        return await user.fetch()
      } catch (error) {
        log.warn('gw.discord.reaction_user.fetch_failed', {
          message: 'Could not fetch partial Discord reaction user',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        return undefined
      }
    }

    return user as User
  }

  private async cancelPlaceholderRun(
    placeholder: PendingPlaceholder,
    actorId: string | undefined
  ): Promise<void> {
    const runId = placeholder.acpRunId
    if (runId === undefined || placeholder.cancelDispatching === true) {
      return
    }

    placeholder.cancelRequested = true
    placeholder.cancelActorId = actorId
    placeholder.cancelDispatching = true
    try {
      await this.postJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {})
    } catch (error) {
      placeholder.cancelDispatching = false
      throw error
    }

    log.info('gw.discord.cancel_reaction.applied', {
      message: 'Discord cancel reaction cancelled active run',
      trace: { gatewayId: this.gatewayId, projectId: placeholder.projectId, runId },
      data: {
        actorRef: actorId !== undefined ? `discord:user:${actorId}` : undefined,
        messageId: placeholder.ui.id,
        sessionRef: placeholder.sessionRef,
      },
    })

    await this.noticePlaceholder(
      placeholder.ui,
      `🛑 **Cancel requested:** ${placeholder.promptPreview ?? runId}`
    )
    this.removePendingPlaceholder(placeholder, 'cancel_reaction')
  }

  private async resolveSteeringAvailability(sessionRef: InterfaceSessionRef): Promise<boolean> {
    const params = new URLSearchParams({
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
    })

    try {
      const response = await this.fetchImpl(`${this.acpBaseUrl}/v1/mobile/sessions?${params}`)
      if (!response.ok) {
        return false
      }
      const payload = (await response.json()) as MobileSessionsResponse
      return (
        payload.sessions?.some(
          (session) =>
            session.capabilities?.input === true &&
            typeof session.activeTurnId === 'string' &&
            session.activeTurnId.trim().length > 0 &&
            session.status !== 'inactive'
        ) ?? false
      )
    } catch (error) {
      log.debug('gw.discord.steer_detection_failed', {
        message: 'Could not determine steering capability; using standard queueing',
        trace: { gatewayId: this.gatewayId, projectId: projectIdFromScopeRef(sessionRef.scopeRef) },
        data: { sessionRef: canonicalSessionRefString(sessionRef) },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
      return false
    }
  }

  private async resolveIngressRoute(
    message: Message,
    parentBinding: DiscordInterfaceBinding,
    conversation: {
      conversationRef: string
      threadRef?: string | undefined
    }
  ): Promise<IngressRoute | undefined> {
    const keyword = parseDiscordKeyword(message.content)
    if (keyword === undefined) {
      return {
        content: resolveDiscordIngressContent(message),
        conversation,
        targetChannelId: message.channelId,
        ...(message.channel.isThread() ? { targetThreadId: message.channelId } : {}),
      }
    }

    if (keyword.canonicalKeyword !== 'nt') {
      return undefined
    }

    if (keyword.content.length === 0) {
      await message.reply('Usage: `nt <prompt>`')
      return undefined
    }

    if (message.channel.isThread()) {
      await message.reply('`nt` can only start a thread from a bound channel.')
      return undefined
    }

    const existing = this.keywordRoutesByMessageId.get(message.id)
    if (existing !== undefined) {
      await this.ensureKeywordThreadBinding(parentBinding, conversation.conversationRef, existing)
      return existing
    }

    const thread = await message.startThread({
      name: buildDiscordThreadName(keyword.content),
    })
    const threadRef = `thread:${thread.id}`
    const route: IngressRoute = {
      content: keyword.content,
      conversation: {
        conversationRef: conversation.conversationRef,
        threadRef,
      },
      targetChannelId: thread.id,
      targetThreadId: thread.id,
    }

    this.keywordRoutesByMessageId.set(message.id, route)

    await this.ensureKeywordThreadBinding(parentBinding, conversation.conversationRef, route)

    return route
  }

  private async ensureKeywordThreadBinding(
    parentBinding: DiscordInterfaceBinding,
    conversationRef: string,
    route: IngressRoute
  ): Promise<void> {
    if (route.targetThreadId === undefined || route.conversation.threadRef === undefined) {
      return
    }
    const parentSessionRef = sessionRefFromBinding(parentBinding)
    if (parentSessionRef === undefined) {
      return
    }

    await this.postJson('/v1/interface/bindings', {
      gatewayId: this.gatewayId,
      conversationRef,
      threadRef: route.conversation.threadRef,
      sessionRef: {
        scopeRef: parentSessionRef.scopeRef,
        laneRef: buildDiscordThreadLaneRef(route.targetThreadId),
      },
      ...(parentBinding.projectId !== undefined ? { projectId: parentBinding.projectId } : {}),
      status: 'active',
    })
    await this.refreshBindings()
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
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        await sleep(this.deliveryIdleMs)
      }
    }
  }

  private reconcileLiveSubscriptions(bindings: DiscordInterfaceBinding[]): void {
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

    for (const entry of desired.values()) {
      if (!this.liveSubscriptionsBySessionRef.has(entry.sessionRef)) {
        this.startLiveSubscription(entry)
      }
    }

    for (const sessionRef of [...this.liveSubscriptionsBySessionRef.keys()]) {
      if (!desired.has(sessionRef)) {
        this.stopLiveSubscription(sessionRef, 'binding_removed')
      }
    }
  }

  private startLiveSubscription(input: { sessionRef: string; projectId: string }): void {
    this.stopLiveSubscription(input.sessionRef, 'replaced')

    const subscription: LiveSubscription = {
      sessionRef: input.sessionRef,
      projectId: input.projectId,
      claimedHrcRunIds: new Set(),
      abortController: new AbortController(),
      lastHrcSeq: 0,
      reconnectDelayMs: LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS,
    }

    this.liveSubscriptionsBySessionRef.set(input.sessionRef, subscription)
    this.sessionEventsManager.subscribe(input.sessionRef, input.projectId)
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
        const url = new URL(`${this.acpBaseUrl}/v1/session-refs/events`)
        url.searchParams.set('sessionRef', subscription.sessionRef)
        url.searchParams.set('follow', 'true')
        url.searchParams.set('fromSeq', String(subscription.lastHrcSeq + 1 || 1))

        log.debug('gw.live_progress.subscribe', {
          trace: { gatewayId: this.gatewayId, projectId: subscription.projectId },
          data: { sessionRef: subscription.sessionRef, fromSeq: subscription.lastHrcSeq + 1 || 1 },
        })

        const response = await this.fetchImpl(url, {
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
              gatewayId: this.gatewayId,
              projectId: subscription.projectId,
            },
            data: {
              sessionRef: subscription.sessionRef,
              nextFromSeq: subscription.lastHrcSeq + 1,
              backoffMs: subscription.reconnectDelayMs,
            },
            err: { message: error instanceof Error ? error.message : String(error) },
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
          gatewayId: this.gatewayId,
          projectId: subscription.projectId,
          sessionRef: subscription.sessionRef,
        },
        err: { message: error instanceof Error ? error.message : String(error) },
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
      const claimed = this.claimPendingPlaceholder(subscription, event)
      if (!claimed) {
        return
      }
    }

    const envelope = adaptHrcLifecycleEvent(event)
    if (!envelope) {
      return
    }

    this.sessionEventsManager.receive(envelope)
    if (envelope.event.type === 'turn_end') {
      const placeholder = this.findPlaceholderByHrcRunId(envelope.sessionRef, hrcRunId)
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
    const placeholder = this.findPlaceholderByHrcRunId(sessionRef, runId)
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
    const placeholder = this.findPlaceholderByHrcRunId(sessionRef, runId)
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

    const result = await this.editPlaceholderProgress(
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
        gatewayId: this.gatewayId,
        projectId: subscription.projectId,
      },
      data: { reason, sessionRef },
    })
    this.clearLiveSubscription(subscription)
    this.liveSubscriptionsBySessionRef.delete(sessionRef)
    this.sessionEventsManager.unsubscribe(sessionRef)
  }

  private stopAllLiveSubscriptions(reason: string): void {
    for (const sessionRef of [...this.liveSubscriptionsBySessionRef.keys()]) {
      this.stopLiveSubscription(sessionRef, reason)
    }
  }

  private clearLiveSubscription(subscription: LiveSubscription): void {
    if (!subscription.abortController.signal.aborted) {
      subscription.abortController.abort()
    }
  }

  private registerPendingPlaceholder(input: {
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
          trace: { gatewayId: this.gatewayId, projectId: input.projectId },
          data: { sessionRef, timeoutMs: PENDING_PLACEHOLDER_TIMEOUT_MS },
        })
        this.removePendingPlaceholder(pending, 'pending_timeout')
        void this.describePendingPlaceholderTimeout(pending).then((reason) =>
          this.failPlaceholder(pending.ui, reason)
        )
      }, PENDING_PLACEHOLDER_TIMEOUT_MS),
      runTimeout: setTimeout(() => {
        log.warn('gw.live_progress.run_timeout', {
          message: 'Live progress run timed out before turn_end',
          trace: { gatewayId: this.gatewayId, projectId: input.projectId },
          data: {
            sessionRef,
            acpRunId: pending.acpRunId,
            claimedHrcRunId: pending.claimedHrcRunId,
            timeoutMs: this.liveProgressTimeoutMs,
          },
        })
        this.removePendingPlaceholder(pending, 'run_timeout')
      }, this.liveProgressTimeoutMs),
      editDisabled: false,
      webhookGone: false,
      lastSuccessfulEditAt: 0,
    }

    const list = this.pendingPlaceholdersBySessionRef.get(sessionRef) ?? []
    list.push(pending)
    this.pendingPlaceholdersBySessionRef.set(sessionRef, list)
    this.activePlaceholdersByMessageId.set(input.placeholder.id, pending)
    this.ensureLiveSubscriptionForSessionRef(sessionRef, input.projectId)

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
    }, TYPING_REFRESH_MS)
  }

  private async sendTypingPing(
    channelId: string,
    sessionRef: string,
    projectId: string
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || typeof (channel as { sendTyping?: unknown }).sendTyping !== 'function') {
        return
      }
      await (channel as { sendTyping: () => Promise<unknown> }).sendTyping()
      log.info('gw.discord.typing.refresh', {
        trace: { gatewayId: this.gatewayId, projectId },
        data: { channelId, sessionRef },
      })
    } catch (error) {
      log.warn('gw.discord.typing.error', {
        trace: { gatewayId: this.gatewayId, projectId },
        data: { channelId, sessionRef },
        err: { message: error instanceof Error ? error.message : String(error) },
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
      const response = await this.fetchImpl(
        `${this.acpBaseUrl}/v1/runs/${encodeURIComponent(runId)}`
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

  private async refreshPendingPlaceholderCorrelation(
    placeholder: PendingPlaceholder
  ): Promise<void> {
    if (placeholder.acpRunId === undefined) {
      return
    }

    let payload: AcpRunLookupResponse | undefined
    try {
      const response = await this.fetchImpl(
        `${this.acpBaseUrl}/v1/runs/${encodeURIComponent(placeholder.acpRunId)}`
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

  private ensureLiveSubscriptionForSessionRef(sessionRef: string, projectId: string): void {
    if (this.liveSubscriptionsBySessionRef.has(sessionRef)) {
      return
    }
    this.startLiveSubscription({ sessionRef, projectId })
  }

  private removePendingPlaceholder(placeholder: PendingPlaceholder, reason: string): void {
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
      this.liveSubscriptionsBySessionRef
        .get(placeholder.sessionRef)
        ?.claimedHrcRunIds.delete(placeholder.claimedHrcRunId)
    }

    this.clearPlaceholderTimers(placeholder)
    log.debug('gw.live_progress.placeholder_removed', {
      trace: { gatewayId: this.gatewayId, projectId: placeholder.projectId },
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

  private claimPendingPlaceholder(
    subscription: LiveSubscription,
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
        eventTimestampIsClaimable({ pendingSince: candidate.pendingSince, eventTs: event.ts })
    )
    if (placeholder === undefined) {
      return undefined
    }

    placeholder.claimedHrcRunId = hrcRunId
    subscription.claimedHrcRunIds.add(hrcRunId)
    clearTimeout(placeholder.pendingTimeout)
    log.debug('gw.live_progress.run_claimed', {
      trace: { gatewayId: this.gatewayId, projectId: placeholder.projectId, runId: hrcRunId },
      data: { sessionRef: subscription.sessionRef, acpRunId: placeholder.acpRunId },
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
    // the delivery path when their own run completes.
    if (placeholder.acpRunId !== undefined) {
      return false
    }

    return true
  }

  private findPlaceholderByHrcRunId(
    sessionRef: string,
    hrcRunId: string
  ): PendingPlaceholder | undefined {
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

  private async processDelivery(delivery: DeliveryRequest): Promise<void> {
    try {
      await this.deliverToDiscord(delivery)
      await this.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/ack`, {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/fail`, {
        code: 'discord_delivery_failed',
        message,
      })
      throw error
    }
  }

  private async deliverToDiscord(delivery: DeliveryRequest): Promise<void> {
    const binding = this.bindings.getBindingFor({
      conversationRef: delivery.conversationRef,
      ...(delivery.threadRef ? { threadRef: delivery.threadRef } : {}),
    })
    const deliverySessionRef = canonicalSessionRefString(delivery.sessionRef)
    const placeholder = delivery.runId ? this.placeholdersByRunId.get(delivery.runId) : undefined
    const hrcRunId = placeholder?.claimedHrcRunId ?? delivery.runId
    const liveRunState =
      hrcRunId !== undefined
        ? this.sessionEventsManager.getRunState(deliverySessionRef, hrcRunId)
        : undefined

    // Resolve agent identity from the delivery's sessionRef
    const identity = resolveMessageIdentity(delivery.sessionRef)
    const messageIdentity = placeholder?.identity ?? identity
    const plan = planFinalDeliveryWrite({
      delivery,
      binding,
      run: liveRunState,
      identity: messageIdentity,
      maxChars: this.maxChars,
      renderOptions: this.renderOptions,
    })

    if (placeholder) {
      try {
        if (placeholder.ui.webhookId) {
          // Webhook-created placeholder: edit + overflow via the same webhook
          await this.renderViaWebhook(placeholder.ui, plan, messageIdentity)
        } else {
          // Placeholder exists but has no webhookId (should not happen for agent-originated
          // content, but can occur if placeholder was created before webhook support).
          // NEVER fall back to Rex — best-effort delete the stale placeholder and fall
          // through to the fresh webhook delivery path below.
          log.warn('gw.delivery.placeholder_missing_webhook', {
            message:
              'Placeholder has no webhookId; deleting stale placeholder and sending fresh webhook message',
            trace: { gatewayId: this.gatewayId },
            data: { runId: delivery.runId, placeholderMessageId: placeholder.ui.id },
          })
          await this.deletePlaceholder(placeholder.ui)
          // Fall through to fresh webhook delivery below
        }
      } finally {
        this.removePendingPlaceholder(placeholder, 'final_delivery')
      }
      // If we edited via webhook, we're done. If we fell through (no webhookId),
      // continue to fresh delivery below.
      if (placeholder.ui.webhookId) {
        return
      }
    }

    // Fresh delivery (no placeholder) OR restart fallback (placeholder lost from
    // in-memory placeholdersByRunId after gateway restart, or placeholder had no
    // webhookId). In all cases, send via webhook with the agent's identity.
    // Accept degraded UX: the stale placeholder stays (if it existed) and a new
    // message appears. NEVER fall back to Rex for agent-originated content.
    const targetChannelId =
      threadRefToThreadId(delivery.threadRef) ??
      conversationRefToChannelId(delivery.conversationRef)
    if (!targetChannelId) {
      throw new Error(`Unsupported Discord conversationRef: ${delivery.conversationRef}`)
    }

    // Extract image and media attachments from the frame
    const imageAttachments = extractImagesFromFrame(plan.frame)
    const mediaRefs = extractMediaRefsFromFrame(plan.frame)
    const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
    const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
    const filesPayload = discordFiles.length > 0 ? { files: discordFiles } : {}

    for (let index = 0; index < plan.chunks.length; index += 1) {
      const isLastChunk = index === plan.chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      const chunkContent = plan.chunks[index] ?? ''
      try {
        await this.webhooks.send(targetChannelId, {
          content: chunkContent,
          username: messageIdentity.agentId,
          avatarURL: messageIdentity.avatarUrl,
          ...chunkFiles,
        })
      } catch (error) {
        classifyDiscordError(error, 'send', { channelId: targetChannelId })
        throw error
      }
    }
  }

  /**
   * Render a final frame by editing a webhook-created placeholder in place,
   * and sending overflow chunks via the same webhook with the same identity.
   */
  private async editPlaceholderProgress(
    ui: UiHandle & { kind: 'message'; webhookId: string },
    frame: RenderFrame,
    identity: DiscordAgentMessageIdentity
  ): Promise<{ ok: boolean; rateLimited: boolean; webhookGone: boolean }> {
    if (!ui.channelId) {
      return { ok: false, rateLimited: false, webhookGone: false }
    }

    const content = buildProgressEditContent({
      frame,
      identity,
      maxChars: Math.min(this.maxChars, 2000),
      maxLines: 12,
    })

    try {
      await this.webhooks.editMessageOnce(ui.channelId, ui.id, ui.webhookId, {
        content,
      })
      return { ok: true, rateLimited: false, webhookGone: false }
    } catch (error) {
      classifyDiscordError(error, 'edit', { channelId: ui.channelId, uiId: ui.id })
      return {
        ok: false,
        rateLimited: isDiscordRateLimit(error),
        webhookGone: isDiscordWebhookGone(error),
      }
    }
  }

  private async renderViaWebhook(
    ui: UiHandle & { kind: 'message' },
    plan: FinalDeliveryWritePlan,
    identity: DiscordAgentMessageIdentity
  ): Promise<void> {
    if (!ui.channelId) return

    // Extract image and media attachments from the frame
    const imageAttachments = extractImagesFromFrame(plan.frame)
    const mediaRefs = extractMediaRefsFromFrame(plan.frame)
    const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
    const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
    const filesPayload = discordFiles.length > 0 ? { files: discordFiles } : {}

    // Edit the placeholder message with the first chunk (prefix already included).
    // Use the explicit 4-arg editMessage(channelId, messageId, webhookId, payload)
    // so the webhook manager resolves the exact webhook that created the placeholder.
    const firstChunk = plan.chunks[0] || ''
    const primaryFiles = plan.chunks.length === 1 ? filesPayload : {}
    await this.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId ?? '', {
      content: firstChunk,
      username: identity.agentId,
      avatarURL: identity.avatarUrl,
      ...primaryFiles,
    })

    // Send overflow chunks via the same webhook with the same identity
    for (let i = 1; i < plan.chunks.length; i++) {
      const chunk = plan.chunks[i]
      if (!chunk) continue
      const isLastChunk = i === plan.chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      await this.webhooks.send(ui.channelId, {
        content: chunk,
        username: identity.agentId,
        avatarURL: identity.avatarUrl,
        ...chunkFiles,
      })
    }
  }

  private async createPlaceholder(input: {
    message: Message
    channelId: string
    threadId?: string | undefined
    content: string
    sessionRef?: InterfaceSessionRef | undefined
  }): Promise<
    | (UiHandle & { kind: 'message'; webhookId?: string; identity?: DiscordAgentMessageIdentity })
    | undefined
  > {
    try {
      const promptPreview =
        input.content.length > 100 ? `${input.content.slice(0, 100)}…` : input.content

      if (input.sessionRef) {
        // Agent-originated: post via webhook with agent identity
        const identity = resolveMessageIdentity(input.sessionRef)
        const sent = await this.webhooks.send(input.channelId, {
          content: `-# ${identity.subtext}\n⏳ **Processing:** ${promptPreview}`,
          username: identity.agentId,
          avatarURL: identity.avatarUrl,
        })

        const webhook = await this.webhooks.getOrCreateWebhook(input.channelId)

        return {
          gatewayId: this.gatewayId,
          kind: 'message',
          id: sent.id,
          channelId: input.channelId,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          webhookId: webhook.id,
          identity,
        }
      }

      // No sessionRef means no agent identity. For bound channels this should
      // never happen (handleMessageCreate always passes binding.sessionRef).
      // Do NOT fall back to Rex — log and skip so we never post agent content
      // under the bot identity.
      log.warn('gw.discord.placeholder.no_session_ref', {
        message: 'createPlaceholder called without sessionRef; skipping to avoid Rex identity leak',
        trace: { gatewayId: this.gatewayId },
        data: { channelId: input.channelId },
      })
      return undefined
    } catch (error) {
      log.warn('gw.discord.placeholder.failed', {
        message: 'Failed to send placeholder',
        trace: { gatewayId: this.gatewayId },
        data: { channelId: input.channelId },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
      return undefined
    }
  }

  private async deletePlaceholder(ui: UiHandle & { kind: 'message' }): Promise<void> {
    if (!ui.channelId) {
      return
    }

    try {
      const channel = await this.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.delete()
      }
    } catch {
      // best-effort cleanup only
    }
  }

  /**
   * Fallback when ACP ingress fails and no placeholder exists to edit
   * (e.g. createPlaceholder returned undefined). Replies to the original
   * inbound message so the user sees the failure inline. Best-effort.
   */
  private async replyIngressFailure(message: Message, reason: string): Promise<void> {
    try {
      await message.reply(`⚠️ ${reason}`)
    } catch {
      // best-effort: never surface a secondary failure
    }
  }

  /**
   * Replace a `⏳ Processing` placeholder in-place with a visible `⚠️` failure
   * notice. Used both when ACP ingress throws and when ingress returns a
   * non-2xx response, so the user sees the failure at the same location they
   * were watching instead of getting silence.
   */
  private async failPlaceholder(
    ui: UiHandle & { kind: 'message'; webhookId?: string | undefined },
    reason: string
  ): Promise<void> {
    if (!ui.channelId) {
      return
    }

    try {
      if (ui.webhookId) {
        // Webhook-created placeholder: edit via the same webhook (4-arg form)
        await this.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId, {
          content: `⚠️ ${reason}`,
        })
        return
      }

      const channel = await this.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.edit({ content: `⚠️ ${reason}` })
      }
    } catch {
      // best-effort cleanup only
    }
  }

  private async noticePlaceholder(
    ui: UiHandle & {
      kind: 'message'
      webhookId?: string | undefined
      identity?: DiscordAgentMessageIdentity | undefined
    },
    content: string
  ): Promise<void> {
    if (!ui.channelId) {
      return
    }

    const rendered = ui.identity !== undefined ? `-# ${ui.identity.subtext}\n${content}` : content

    try {
      if (ui.webhookId) {
        await this.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId, {
          content: rendered,
        })
        return
      }

      const channel = await this.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.edit({ content: rendered })
      }
    } catch {
      // best-effort cleanup only
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.acpBaseUrl}${path}`)
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
    return (await response.json()) as T
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.acpBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
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
