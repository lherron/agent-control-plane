import type { InputIntent, InterfaceSessionRef } from 'acp-core'
import {
  type Client,
  type Message,
  type MessageReaction,
  MessageType,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js'

import { mapDiscordMessageAttachments, resolveDiscordIngressContent } from './attachment-ingress.js'
import { type BindingIndex, toConversationRefs } from './bindings.js'
import { VIRTU_BOT_ID } from './config.js'
import {
  type KeywordRoute,
  buildDiscordThreadLaneRef,
  buildDiscordThreadName,
  parseDiscordKeyword,
} from './keywords.js'
import type { DiscordLedgerEgress } from './ledger-human-egress.js'
import type { DiscordInterfaceBinding } from './types.js'

import type { GatewayAcpClient } from './acp-client.js'
import type { DiscordOutput } from './discord-output.js'
import {
  canonicalSessionRefString,
  projectIdFromScopeRef,
  sessionRefFromBinding,
} from './discord-session-ref.js'
import { log } from './gateway-log.js'
import { extractIngressFailureReason } from './ingress-failure.js'
import type { LedgerResponses } from './ledger-responses.js'
import type { LiveProgress } from './live-progress.js'
import type { PendingResponses } from './pending-responses.js'
import type { PendingPlaceholder } from './pending-responses.js'

const CANCEL_REACTION_NAMES = new Set(['x', 'cancel', '❌', '✖', '✕', '✖️'])

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

function collaborationRouteFromState(
  state: Record<string, unknown> | undefined
): { roomUuid: string; roomKey: string; envelopeId?: string | undefined } | undefined {
  if (state?.['delivery'] !== 'collaboration_ledger') return undefined
  const roomUuid = state['roomUuid']
  const roomKey = state['roomKey']
  const envelopeId = state['envelopeId']
  return typeof roomUuid === 'string' &&
    roomUuid.length > 0 &&
    typeof roomKey === 'string' &&
    roomKey.length > 0
    ? {
        roomUuid,
        roomKey,
        ...(typeof envelopeId === 'string' && envelopeId.length > 0 ? { envelopeId } : {}),
      }
    : undefined
}

type LedgerCancelResult = {
  outcome: 'interrupted' | 'withdrawn' | 'not_applied'
  reason?: string | undefined
  node?: string | undefined
  runtimeId?: string | undefined
}

export class DiscordIngress {
  private readonly keywordRoutesByMessageId = new Map<string, IngressRoute>()
  constructor(
    private readonly options: {
      acp: Pick<GatewayAcpClient, 'baseUrl' | 'dashboardSnapshot' | 'fetch' | 'postJson'>
      bindings: BindingIndex
      client: Client
      gatewayId: string
      ledger: Pick<LedgerResponses, 'registerLedgerInFlight' | 'retireLedgerInFlight'>
      ledgerHumanEgress: DiscordLedgerEgress | undefined
      live: Pick<LiveProgress, 'sessionEventsManager'>
      output: Pick<
        DiscordOutput,
        | 'createPlaceholder'
        | 'deletePlaceholder'
        | 'failPlaceholder'
        | 'noticePlaceholder'
        | 'replyIngressFailure'
      >
      pending: Pick<
        PendingResponses,
        | 'activePlaceholdersByMessageId'
        | 'placeholdersByRunId'
        | 'refreshPendingPlaceholderCorrelation'
        | 'registerPendingPlaceholder'
        | 'removePendingPlaceholder'
      >
      refreshBindings: () => Promise<DiscordInterfaceBinding[]>
    }
  ) {}

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

    const placeholder = this.options.pending.activePlaceholdersByMessageId.get(
      resolvedReaction.message.id
    )
    if (placeholder === undefined) {
      return
    }

    if (placeholder.ledgerInFlight !== undefined) {
      await this.cancelLedgerInput(placeholder, actor.id)
      return
    }

    if (placeholder.acpRunId === undefined) {
      placeholder.cancelRequested = true
      placeholder.cancelActorId = actor?.id
      log.info('gw.discord.cancel_reaction.deferred', {
        message: 'Cancel reaction recorded before the ACP run id or ledger route was available',
        trace: { gatewayId: this.options.gatewayId, projectId: placeholder.projectId },
        data: {
          messageId: placeholder.ui.id,
          sessionRef: placeholder.sessionRef,
        },
      })
      return
    }

    await this.cancelPlaceholderRun(placeholder, actor?.id)
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
      } else if (message.author.id === this.options.client.user?.id) {
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

    let binding = this.options.bindings.getBindingFor(conversation)
    if (!binding) {
      await this.options.refreshBindings()
      binding = this.options.bindings.getBindingFor(conversation)
    }
    if (binding && conversation.threadRef !== undefined && binding.threadRef === undefined) {
      await this.options.refreshBindings()
      binding = this.options.bindings.getBindingFor(conversation)
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
        ? (this.options.bindings.getBindingFor(route.conversation) ?? binding)
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

    const placeholder = await this.options.output.createPlaceholder({
      message,
      channelId: route.targetChannelId,
      content: ingressContent,
      ...(route.targetThreadId !== undefined ? { threadId: route.targetThreadId } : {}),
      sessionRef: effectiveSessionRef,
    })
    const pendingPlaceholder =
      placeholder !== undefined
        ? this.options.pending.registerPendingPlaceholder({
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
      const intent = await this.resolveInputIntent(effectiveSessionRef)

      response = await this.options.acp.fetch(`${this.options.acp.baseUrl}/v1/interface/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: `discord:message:${message.id}`,
          source: {
            gatewayId: this.options.gatewayId,
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
        this.options.pending.removePendingPlaceholder(pendingPlaceholder, 'post_failed')
      }
      if (placeholder) {
        await this.options.output.failPlaceholder(placeholder, `Could not reach ACP: ${reason}`)
      }
      throw error
    }

    if (!response.ok) {
      const rawBody = await response.text()
      const reason = extractIngressFailureReason(rawBody) ?? `HTTP ${response.status}`
      if (pendingPlaceholder) {
        this.options.pending.removePendingPlaceholder(pendingPlaceholder, 'post_failed')
      }
      if (placeholder) {
        await this.options.output.failPlaceholder(placeholder, `Agent invocation failed: ${reason}`)
      } else {
        await this.options.output.replyIngressFailure(message, `Agent invocation failed: ${reason}`)
      }
      throw new Error(`Interface ingress failed: ${response.status} ${rawBody}`)
    }

    const payload = (await response.json()) as InterfaceMessageResponse
    const collaborationRoute = collaborationRouteFromState(payload.currentState)
    if (collaborationRoute !== undefined && this.options.ledgerHumanEgress !== undefined) {
      this.options.ledgerHumanEgress.recordRoute({
        ...collaborationRoute,
        bindingId: routeBinding.bindingId,
        conversationRef: route.conversation.conversationRef,
        ...(route.conversation.threadRef !== undefined
          ? { threadRef: route.conversation.threadRef }
          : {}),
        humanPrincipalRef: 'agent:lance',
      })
    }
    if (pendingPlaceholder) {
      if (collaborationRoute !== undefined) {
        // Ledger-routed ingress: the seat answers through the collaboration
        // ledger, but HRC still emits the ordinary session lifecycle. Keep the
        // placeholder in the pending roster so the existing session/time-window
        // claim and RenderFrame engine can use it as the live progress surface.
        // The correlated human notice replaces this message at egress, preserving
        // the single-bubble guarantee from 11741a2 without painting a fake steer.
        if (this.options.ledgerHumanEgress !== undefined) {
          this.options.ledger.registerLedgerInFlight({
            placeholder: pendingPlaceholder,
            route: collaborationRoute,
            bindingId: routeBinding.bindingId,
          })
          if (pendingPlaceholder.cancelRequested === true) {
            await this.cancelLedgerInput(pendingPlaceholder, pendingPlaceholder.cancelActorId)
          }
        } else {
          // A deployment without ledger egress cannot ever replace this live
          // surface. Preserve the prior no-stale-placeholder behavior.
          this.options.pending.removePendingPlaceholder(
            pendingPlaceholder,
            'collaboration_ledger_no_egress'
          )
          await this.options.output.deletePlaceholder(pendingPlaceholder.ui)
        }
      } else if (payload.runId !== undefined) {
        pendingPlaceholder.acpRunId = payload.runId
        await this.options.pending.refreshPendingPlaceholderCorrelation(pendingPlaceholder)
        this.options.pending.placeholdersByRunId.set(payload.runId, pendingPlaceholder)
        if (pendingPlaceholder.cancelRequested === true) {
          await this.cancelPlaceholderRun(pendingPlaceholder, pendingPlaceholder.cancelActorId)
        }
      } else if (
        payload.admission?.kind === 'accepted_in_flight' ||
        payload.admission?.kind === 'admission_pending'
      ) {
        this.options.pending.removePendingPlaceholder(pendingPlaceholder, payload.admission.kind)
        await this.options.output.noticePlaceholder(
          pendingPlaceholder.ui,
          payload.admission.kind === 'accepted_in_flight'
            ? `↪️ **Steered active run:** ${pendingPlaceholder.promptPreview ?? 'Input accepted'}`
            : `⏳ **Steering pending:** ${pendingPlaceholder.promptPreview ?? 'Input pending'}`
        )
      } else if (payload.admission?.kind === 'rejected') {
        this.options.pending.removePendingPlaceholder(pendingPlaceholder, 'admission_rejected')
        await this.options.output.failPlaceholder(
          pendingPlaceholder.ui,
          String(payload.currentState?.['reason'] ?? 'Input was rejected')
        )
      }
    }
  }

  private async resolveInputIntent(
    sessionRef: InterfaceSessionRef
  ): Promise<InputIntent | undefined> {
    if (this.findActivePlaceholderForSession(sessionRef) !== undefined) {
      return {
        kind: 'contribute_to_active_run',
        fallback: 'reject',
        contributionSemantics: 'interrupt_and_continue',
      }
    }

    if (await this.resolveSteeringAvailability(sessionRef)) {
      return {
        kind: 'contribute_to_active_run',
        fallback: 'queue',
        contributionSemantics: 'interrupt_and_continue',
      }
    }

    return undefined
  }

  private findActivePlaceholderForSession(
    sessionRef: InterfaceSessionRef
  ): PendingPlaceholder | undefined {
    const wantedSessionRef = canonicalSessionRefString(sessionRef)

    for (const placeholder of this.options.pending.activePlaceholdersByMessageId.values()) {
      if (placeholder.sessionRef !== wantedSessionRef) {
        continue
      }
      const hrcRunId = placeholder.claimedHrcRunId
      if (hrcRunId === undefined) {
        continue
      }

      const run = this.options.live.sessionEventsManager.getRunState(wantedSessionRef, hrcRunId)
      if (run?.status === 'completed' || run?.status === 'failed' || run?.status === 'cancelled') {
        continue
      }

      return placeholder
    }

    return undefined
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
          trace: { gatewayId: this.options.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
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
          trace: { gatewayId: this.options.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
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
      await this.options.acp.postJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {})
    } catch (error) {
      placeholder.cancelDispatching = false
      throw error
    }

    log.info('gw.discord.cancel_reaction.applied', {
      message: 'Discord cancel reaction cancelled active run',
      trace: {
        gatewayId: this.options.gatewayId,
        projectId: placeholder.projectId,
        runId,
      },
      data: {
        actorRef: actorId !== undefined ? `discord:user:${actorId}` : undefined,
        messageId: placeholder.ui.id,
        sessionRef: placeholder.sessionRef,
      },
    })

    await this.options.output.noticePlaceholder(
      placeholder.ui,
      `🛑 **Cancel requested:** ${placeholder.promptPreview ?? runId}`
    )
    this.options.pending.removePendingPlaceholder(placeholder, 'cancel_reaction')
  }

  /**
   * T-12177: a ledger-routed input has no ACP run. ACP cancels the input
   * envelope itself (withdraw, or interrupt the turn its receipt names on that
   * turn's node). Every outcome, including a failed call, is shown on the
   * placeholder, and the in-flight is retired so live progress cannot paint
   * over the result; a later reply posts as a fresh message.
   */
  private async cancelLedgerInput(
    placeholder: PendingPlaceholder,
    actorId: string | undefined
  ): Promise<void> {
    const inFlight = placeholder.ledgerInFlight
    if (inFlight === undefined || placeholder.cancelDispatching === true) {
      return
    }
    placeholder.cancelRequested = true
    placeholder.cancelActorId = actorId
    placeholder.cancelDispatching = true

    const envelopeId = inFlight.inputEnvelopeId
    let result: LedgerCancelResult
    if (envelopeId === undefined) {
      result = { outcome: 'not_applied', reason: 'ingress returned no ledger envelope' }
    } else {
      result = await this.requestLedgerCancel(envelopeId, inFlight.roomUuid, actorId)
    }

    const preview = placeholder.promptPreview ?? envelopeId ?? 'request'
    const content =
      result.outcome === 'interrupted'
        ? `🛑 **Cancelled:** ${preview}`
        : result.outcome === 'withdrawn'
          ? `🛑 **Cancelled (withdrawn before presentation):** ${preview}`
          : `⚠️ **Cancel not applied:** ${result.reason ?? 'unknown reason'}`

    log.info(
      result.outcome === 'not_applied'
        ? 'gw.discord.cancel_reaction.not_applied'
        : 'gw.discord.cancel_reaction.applied',
      {
        message: 'Discord cancel reaction on a ledger-routed placeholder',
        trace: { gatewayId: this.options.gatewayId, projectId: placeholder.projectId },
        data: {
          route: 'ledger',
          envelopeId,
          roomKey: inFlight.roomKey,
          outcome: result.outcome,
          reason: result.reason,
          node: result.node,
          runtimeId: result.runtimeId,
          actorRef: actorId !== undefined ? `discord:user:${actorId}` : undefined,
          messageId: placeholder.ui.id,
          sessionRef: placeholder.sessionRef,
        },
      }
    )

    await this.options.ledger.retireLedgerInFlight(
      inFlight,
      `cancel_reaction_${result.outcome}`,
      {}
    )
    await this.options.output.noticePlaceholder(placeholder.ui, content)
  }

  private async requestLedgerCancel(
    envelopeId: string,
    roomUuid: string,
    actorId: string | undefined
  ): Promise<LedgerCancelResult> {
    try {
      const response = await this.options.acp.fetch(
        `${this.options.acp.baseUrl}/v1/interface/ledger-inputs/${encodeURIComponent(envelopeId)}/cancel`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            gatewayId: this.options.gatewayId,
            roomUuid,
            ...(actorId !== undefined ? { actorRef: `discord:user:${actorId}` } : {}),
          }),
        }
      )
      if (!response.ok) {
        const reason =
          extractIngressFailureReason(await response.text()) ?? `HTTP ${response.status}`
        return { outcome: 'not_applied', reason }
      }
      const body = (await response.json()) as Partial<LedgerCancelResult>
      return body.outcome === 'interrupted' ||
        body.outcome === 'withdrawn' ||
        body.outcome === 'not_applied'
        ? (body as LedgerCancelResult)
        : { outcome: 'not_applied', reason: 'unrecognized cancel response' }
    } catch (error) {
      return {
        outcome: 'not_applied',
        reason: `could not reach ACP: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async resolveSteeringAvailability(sessionRef: InterfaceSessionRef): Promise<boolean> {
    const wantedSessionRef = `${sessionRef.scopeRef}/lane:${sessionRef.laneRef}`

    try {
      const snapshot = await this.options.acp.dashboardSnapshot(this.options.acp.baseUrl)
      return (
        snapshot.sessions?.some(
          (session) =>
            session.sessionRef === wantedSessionRef &&
            session.capabilities?.input === true &&
            typeof session.activeTurnId === 'string' &&
            session.activeTurnId.trim().length > 0 &&
            (session.summaryStatus ?? session.status) !== 'inactive'
        ) ?? false
      )
    } catch (error) {
      log.debug('gw.discord.steer_detection_failed', {
        message: 'Could not determine steering capability; using standard queueing',
        trace: {
          gatewayId: this.options.gatewayId,
          projectId: projectIdFromScopeRef(sessionRef.scopeRef),
        },
        data: { sessionRef: canonicalSessionRefString(sessionRef) },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
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
      content: resolveDiscordIngressContent(message, keyword.content),
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

    await this.options.acp.postJson('/v1/interface/bindings', {
      gatewayId: this.options.gatewayId,
      gatewayType: 'discord',
      conversationRef,
      threadRef: route.conversation.threadRef,
      sessionRef: {
        scopeRef: parentSessionRef.scopeRef,
        laneRef: buildDiscordThreadLaneRef(route.targetThreadId),
      },
      ...(parentBinding.projectId !== undefined ? { projectId: parentBinding.projectId } : {}),
      status: 'active',
    })
    await this.options.refreshBindings()
  }
}
