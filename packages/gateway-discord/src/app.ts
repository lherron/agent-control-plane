import { randomUUID } from 'node:crypto'

import type { DeliveryRequest, InputIntent, InterfaceSessionRef } from 'acp-core'
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js'

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
import { adaptHrcLifecycleEvent } from './hrc-event-adapter.js'
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
import {
  type RenderOptions,
  buildProgressBubble,
  extractImagesFromFrame,
  extractMediaRefsFromFrame,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from './render.js'
import { type RunState, SessionEventsManager } from './session-events-manager.js'
import type {
  DeliveryStreamResponse,
  DiscordInterfaceBinding,
  RenderBlock,
  RenderFrame,
  UiHandle,
} from './types.js'
import { createWebhookManager } from './webhooks.js'

const VIRTU_BOT_ID = optionalEnv('DISCORD_VIRTU_BOT_ID') ?? '1165644636807778414'

const MAX_INGRESS_FAILURE_REASON_CHARS = 400
const LIVE_PROGRESS_EDIT_THROTTLE_MS = 1500
const LIVE_PROGRESS_INITIAL_FLUSH_MS = 150
const LIVE_PROGRESS_RATE_LIMIT_BACKOFF_MS = 60_000
const DEFAULT_LIVE_PROGRESS_TIMEOUT_MS = 60 * 60 * 1000
const PENDING_PLACEHOLDER_TIMEOUT_MS = 60_000
const LIVE_SUBSCRIPTION_INITIAL_RECONNECT_MS = 1000
const LIVE_SUBSCRIPTION_MAX_RECONNECT_MS = 5000

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
  const parts = scopeRef.split(':')
  const projectIndex = parts.indexOf('project')
  return parts[projectIndex + 1] ?? scopeRef
}

function laneIdFromRef(laneRef: string): string {
  return laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
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

function canonicalSessionRefFromEvent(event: {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}): string | undefined {
  if (!event.scopeRef || !event.laneRef) {
    return undefined
  }
  return `${event.scopeRef}/lane:${laneIdFromRef(event.laneRef)}`
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

function formatToolSummary(toolInput: Record<string, unknown>): string {
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value

  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > 0) {
      return `\`${truncate(value, 80)}\``
    }
  }

  const json = JSON.stringify(toolInput)
  return json.length > 2 ? truncate(json, 80) : ''
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
  identity?: DiscordAgentMessageIdentity | undefined
  promptPreview?: string | undefined
  pendingTimeout: ReturnType<typeof setTimeout>
  runTimeout: ReturnType<typeof setTimeout>
  flushTimer?: ReturnType<typeof setTimeout> | undefined
  disableTimer?: ReturnType<typeof setTimeout> | undefined
  pendingFrame?: RenderFrame | undefined
  pendingRun?: RunState | undefined
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

function buildFinalFrame(
  delivery: DeliveryRequest,
  binding?: DiscordInterfaceBinding,
  run?: RunState | undefined
): RenderFrame {
  const blocks: RenderBlock[] = []

  if (run) {
    const timelineBlocks: Array<{ seq: number; block: RenderBlock }> = []
    for (const tool of run.toolExecutions) {
      timelineBlocks.push({
        seq: tool.seq,
        block: {
          t: 'tool',
          toolName: tool.toolName,
          summary: formatToolSummary(tool.input),
          input: tool.input,
          approved:
            tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined,
        },
      })
    }
    for (const notice of run.noticeEntries) {
      timelineBlocks.push({
        seq: notice.seq,
        block: {
          t: 'notice',
          level: notice.level,
          message: notice.message,
        },
      })
    }
    blocks.push(
      ...timelineBlocks.sort((left, right) => left.seq - right.seq).map((item) => item.block)
    )
  }

  blocks.push({ t: 'markdown', md: delivery.body.text })

  appendDeliveryAttachments(blocks, delivery)

  return {
    runId: delivery.runId ?? delivery.deliveryRequestId,
    projectId: binding?.projectId ?? delivery.sessionRef.scopeRef,
    phase: 'final',
    blocks,
    updatedAt: Date.now(),
  }
}

function buildCompactCompositeFinalFrame(
  delivery: DeliveryRequest,
  binding: DiscordInterfaceBinding | undefined,
  run: RunState,
  identity: DiscordAgentMessageIdentity,
  maxChars: number
): RenderFrame {
  const historyFrame = buildFinalFrame(delivery, binding, run)
  const prefixBudget = `-# ${identity.subtext}\n`.length
  const content = buildProgressBubble(historyFrame, {
    maxChars: Math.max(1, Math.min(maxChars, 1900) - prefixBudget),
    maxLines: 12,
  })
  const blocks: RenderBlock[] = [{ t: 'markdown', md: content }]
  appendDeliveryAttachments(blocks, delivery)
  return {
    ...historyFrame,
    blocks,
  }
}

function appendDeliveryAttachments(blocks: RenderBlock[], delivery: DeliveryRequest): void {
  if (!delivery.body.attachments) {
    return
  }

  for (const attachment of delivery.body.attachments) {
    const url = attachment.url ?? attachment.path
    if (!url) continue
    blocks.push({
      t: 'media_ref',
      url,
      ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.alt ? { alt: attachment.alt } : {}),
    })
  }
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
  private readonly createdClient: boolean
  private readonly onMessageCreateBound: (message: Message) => Promise<void>
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
          GatewayIntentBits.MessageContent,
        ],
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
      (projectId, runId, frame, run) => {
        this.scheduleProgressEdit(projectId, runId, frame, run)
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
  }

  async start(): Promise<void> {
    await this.refreshBindings()
    this.client.on(Events.MessageCreate, this.onMessageCreateBound)

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
    if (this.bindingsTimer) {
      clearInterval(this.bindingsTimer)
      this.bindingsTimer = undefined
    }

    if (this.deliveryLoopPromise) {
      await this.deliveryLoopPromise
      this.deliveryLoopPromise = undefined
    }

    this.client.off(Events.MessageCreate, this.onMessageCreateBound)
    if (this.createdClient) {
      this.client.destroy()
    }
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
      await message.reply(
        'No project is bound to this channel/thread. Use ACP interface bindings to create one.'
      )
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
        this.placeholdersByRunId.set(payload.runId, pendingPlaceholder)
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
    this.sessionEventsManager.subscribe(input.projectId)
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
      const placeholder = this.findPlaceholderByHrcRunId(hrcRunId)
      if (placeholder?.runTimeout) {
        clearTimeout(placeholder.runTimeout)
      }
    }
  }

  private scheduleProgressEdit(
    projectId: string,
    runId: string,
    frame: RenderFrame,
    run: RunState
  ): void {
    const placeholder = this.findPlaceholderByHrcRunId(runId)
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
      void this.flushProgressEdit(runId)
    }, delay)
  }

  private async flushProgressEdit(runId: string): Promise<void> {
    const placeholder = this.findPlaceholderByHrcRunId(runId)
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
    this.ensureLiveSubscriptionForSessionRef(sessionRef, input.projectId)
    return pending
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

  private findPlaceholderByHrcRunId(hrcRunId: string): PendingPlaceholder | undefined {
    for (const placeholder of this.placeholdersByRunId.values()) {
      if (placeholder.claimedHrcRunId === hrcRunId) {
        return placeholder
      }
    }

    for (const placeholders of this.pendingPlaceholdersBySessionRef.values()) {
      const found = placeholders.find((placeholder) => placeholder.claimedHrcRunId === hrcRunId)
      if (found !== undefined) {
        return found
      }
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
    const projectId = binding?.projectId ?? projectIdFromScopeRef(delivery.sessionRef.scopeRef)
    const placeholder = delivery.runId ? this.placeholdersByRunId.get(delivery.runId) : undefined
    const hrcRunId = placeholder?.claimedHrcRunId ?? delivery.runId
    const liveRunState =
      hrcRunId !== undefined
        ? this.sessionEventsManager.getRunState(projectId, hrcRunId)
        : undefined

    // Resolve agent identity from the delivery's sessionRef
    const identity = resolveMessageIdentity(delivery.sessionRef)
    const frame = liveRunState
      ? buildCompactCompositeFinalFrame(delivery, binding, liveRunState, identity, this.maxChars)
      : buildFinalFrame(delivery, binding)

    if (placeholder) {
      try {
        if (placeholder.ui.webhookId) {
          // Webhook-created placeholder: edit + overflow via the same webhook
          await this.renderViaWebhook(placeholder.ui, frame, placeholder.identity ?? identity)
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

    const rawContent = renderFrameToDiscordContent(frame, this.maxChars)
    // Build full prefixed content FIRST so the subtext prefix is budgeted into
    // chunk sizes, preventing BASE_TYPE_MAX_LENGTH overflow (smoke issue 4).
    const prefixedContent = `-# ${identity.subtext}\n${rawContent}`
    const chunks = splitIntoChunks(prefixedContent, this.maxChars, this.renderOptions)

    // Extract image and media attachments from the frame
    const imageAttachments = extractImagesFromFrame(frame)
    const mediaRefs = extractMediaRefsFromFrame(frame)
    const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
    const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
    const filesPayload = discordFiles.length > 0 ? { files: discordFiles } : {}

    for (let index = 0; index < chunks.length; index += 1) {
      const isLastChunk = index === chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      const chunkContent = chunks[index] ?? ''
      try {
        await this.webhooks.send(targetChannelId, {
          content: chunkContent,
          username: identity.agentId,
          avatarURL: identity.avatarUrl,
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

    const promptPreview = frame.title ?? 'Progress'
    const phaseEmoji =
      frame.phase === 'final'
        ? '✅'
        : frame.phase === 'error'
          ? '❌'
          : frame.phase === 'permission'
            ? '🔐'
            : '⏳'
    const bubble = buildProgressBubble(frame, { maxChars: 1900, maxLines: 12 })
    const content = `-# ${identity.subtext}\n${phaseEmoji} ${promptPreview}\n${bubble}`

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
    frame: RenderFrame,
    identity: DiscordAgentMessageIdentity
  ): Promise<void> {
    if (!ui.channelId) return

    const rawContent = renderFrameToDiscordContent(frame, this.maxChars)
    // Build full prefixed content FIRST so the subtext prefix is budgeted into
    // chunk sizes, preventing BASE_TYPE_MAX_LENGTH overflow (smoke issue 4).
    const prefixedContent = `-# ${identity.subtext}\n${rawContent}`
    const chunks = splitIntoChunks(prefixedContent, this.maxChars, this.renderOptions)

    // Extract image and media attachments from the frame
    const imageAttachments = extractImagesFromFrame(frame)
    const mediaRefs = extractMediaRefsFromFrame(frame)
    const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
    const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
    const filesPayload = discordFiles.length > 0 ? { files: discordFiles } : {}

    // Edit the placeholder message with the first chunk (prefix already included).
    // Use the explicit 4-arg editMessage(channelId, messageId, webhookId, payload)
    // so the webhook manager resolves the exact webhook that created the placeholder.
    const firstChunk = chunks[0] || ''
    const primaryFiles = chunks.length === 1 ? filesPayload : {}
    await this.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId ?? '', {
      content: firstChunk,
      username: identity.agentId,
      avatarURL: identity.avatarUrl,
      ...primaryFiles,
    })

    // Send overflow chunks via the same webhook with the same identity
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (!chunk) continue
      const isLastChunk = i === chunks.length - 1
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
