import type { Client } from 'discord.js'
import { isDiscordWebhookGone } from './discord-errors.js'
import { actorSlug } from './identity.js'
import type { DiscordLedgerSink } from './ledger-human-egress.js'
import { type RenderOptions, splitIntoChunks } from './render.js'
import type { createWebhookManager } from './webhooks.js'
import { planLedgerHumanNoticeContent } from './write-plan.js'

import type { DiscordOutput } from './discord-output.js'
import { log } from './gateway-log.js'
import type { LiveProgress } from './live-progress.js'
import type { PendingResponses } from './pending-responses.js'
import type { PendingPlaceholder } from './pending-responses.js'

export type LedgerInFlight = {
  roomUuid: string
  roomKey: string
  bindingId: string
  inputEnvelopeId?: string | undefined
  inputMessageSeq?: number | undefined
  sessionRef: string
  projectId: string
  pendingSince: number
  placeholder: PendingPlaceholder
  timeout?: ReturnType<typeof setTimeout> | undefined
}

function envelopeMessageSeq(envelopeId: string | undefined): number | undefined {
  if (envelopeId === undefined) return undefined
  const match = /^EN-(\d+)$/.exec(envelopeId)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

export class LedgerResponses {
  private readonly ledgerInFlightsByRoomUuid = new Map<string, LedgerInFlight[]>()
  constructor(
    private readonly options: {
      client: Client
      gatewayId: string
      live: Pick<LiveProgress, 'ensureLiveSubscriptionForSessionRef' | 'sessionEventsManager'>
      liveProgressTimeoutMs: number
      maxChars: number
      maxRateLimitAttempts: number
      output: Pick<DiscordOutput, 'avatarForAgent' | 'deletePlaceholder' | 'failPlaceholder'>
      pending: Pick<PendingResponses, 'removePendingPlaceholder'>
      renderOptions: RenderOptions
      retainTurnProgress: boolean
      webhooks: ReturnType<typeof createWebhookManager>
    }
  ) {}

  clear(): void {
    for (const inFlights of this.ledgerInFlightsByRoomUuid.values()) {
      for (const inFlight of inFlights) this.clearLedgerInFlight(inFlight)
    }
    this.ledgerInFlightsByRoomUuid.clear()
  }

  async sendLedgerEnvelopeSink(input: DiscordLedgerSink): Promise<{ messageId: string }> {
    const sink = {
      ...input,
      payload: {
        ...input.payload,
        avatar_url: this.options.output.avatarForAgent(actorSlug(input.envelope.from.principalRef)),
      },
    }
    if (sink.kind === 'human-notice') {
      const inFlights = this.ledgerInFlightsForReply(sink)
      const replacement = inFlights.at(-1)
      const ui = replacement?.placeholder.ui
      if (replacement !== undefined && ui?.channelId !== undefined && ui.webhookId !== undefined) {
        try {
          const hrcRunId = replacement.placeholder.claimedHrcRunId
          const run =
            hrcRunId === undefined
              ? undefined
              : this.options.live.sessionEventsManager.getRunState(replacement.sessionRef, hrcRunId)
          const plannedContent = planLedgerHumanNoticeContent({
            replyContent: sink.payload.content ?? '',
            run,
            retainTurnProgress: this.options.retainTurnProgress,
            maxChars: Math.min(this.options.maxChars, 2000),
          })
          const chunks = splitIntoChunks(
            plannedContent,
            Math.min(this.options.maxChars, 2000),
            this.options.renderOptions
          )
          const payload = {
            ...sink.payload,
            content: chunks[0] ?? '',
          }
          const edited = await this.options.webhooks.editMessage(
            ui.channelId,
            ui.id,
            ui.webhookId,
            payload
          )
          for (const chunk of chunks.slice(1)) {
            await this.options.webhooks.send(
              ui.channelId,
              {
                ...sink.payload,
                content: chunk,
              },
              { maxRateLimitAttempts: this.options.maxRateLimitAttempts }
            )
          }
          for (const inFlight of inFlights) {
            await this.retireLedgerInFlight(inFlight, 'human_notice', {
              deletePlaceholder: inFlight !== replacement,
            })
          }
          log.info('gw.ledger_egress.sent', {
            trace: { gatewayId: this.options.gatewayId },
            data: {
              envelopeId: sink.envelope.id,
              roomKey: sink.envelope.roomKey,
              sink: sink.kind,
              bindingId: sink.route.bindingId,
              channelId: sink.channelId,
              messageId: edited.id,
              outcome: 'placeholder_replaced',
            },
          })
          return { messageId: edited.id }
        } catch (error) {
          // A missing webhook/message means the progress surface is already
          // gone. Fall back to a fresh human notice; transient edit failures
          // remain retryable through the durable ledger delivery state.
          if (!isDiscordWebhookGone(error)) {
            throw error
          }
        }
      }
    }

    const chunks =
      sink.kind === 'human-notice'
        ? splitIntoChunks(
            sink.payload.content ?? '',
            Math.min(this.options.maxChars, 2000),
            this.options.renderOptions
          )
        : [sink.payload.content]
    let sent: { id: string } | undefined
    for (const chunk of chunks) {
      const message = await this.options.webhooks.send(
        sink.channelId,
        {
          ...sink.payload,
          ...(chunk !== undefined ? { content: chunk } : {}),
        },
        { maxRateLimitAttempts: this.options.maxRateLimitAttempts }
      )
      sent ??= message
    }
    if (sent === undefined) {
      throw new Error(`Discord ledger ${sink.kind} produced no message`)
    }
    if (sink.kind === 'human-notice') {
      for (const inFlight of this.ledgerInFlightsForReply(sink)) {
        await this.retireLedgerInFlight(inFlight, 'human_notice_fallback', {
          deletePlaceholder: true,
        })
      }
    }
    log.info('gw.ledger_egress.sent', {
      trace: { gatewayId: this.options.gatewayId },
      data: {
        envelopeId: sink.envelope.id,
        roomKey: sink.envelope.roomKey,
        sink: sink.kind,
        ...(sink.kind === 'human-notice' ? { bindingId: sink.route.bindingId } : {}),
        channelId: sink.channelId,
        messageId: sent.id,
      },
    })
    return { messageId: sent.id }
  }

  async findRecentLedgerMessageId(
    channelId: string,
    envelopeId: string
  ): Promise<string | undefined> {
    const channel = await this.options.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      throw new Error(`Discord channel ${channelId} cannot reconcile ledger messages`)
    }
    const messages = await channel.messages.fetch({ limit: 100 })
    for (const message of messages.values()) {
      if (
        message.content.includes(envelopeId) ||
        message.embeds.some(
          (embed) =>
            embed.title?.includes(envelopeId) === true ||
            embed.description?.includes(envelopeId) === true ||
            embed.footer?.text.includes(envelopeId) === true ||
            embed.fields.some(
              (field) => field.name.includes(envelopeId) || field.value.includes(envelopeId)
            )
        )
      ) {
        return message.id
      }
    }
    return undefined
  }

  registerLedgerInFlight(input: {
    placeholder: PendingPlaceholder
    route: {
      roomUuid: string
      roomKey: string
      envelopeId?: string | undefined
    }
    bindingId: string
  }): void {
    const inFlight: LedgerInFlight = {
      roomUuid: input.route.roomUuid,
      roomKey: input.route.roomKey,
      bindingId: input.bindingId,
      ...(input.route.envelopeId !== undefined
        ? {
            inputEnvelopeId: input.route.envelopeId,
            inputMessageSeq: envelopeMessageSeq(input.route.envelopeId),
          }
        : {}),
      sessionRef: input.placeholder.sessionRef,
      projectId: input.placeholder.projectId,
      pendingSince: input.placeholder.pendingSince,
      placeholder: input.placeholder,
    }
    input.placeholder.ledgerInFlight = inFlight
    inFlight.timeout = setTimeout(() => {
      void this.retireLedgerInFlight(inFlight, 'timeout', {
        notice: `Reply timed out before completion — full details: wrkc show ${inFlight.inputEnvelopeId}`,
      })
    }, this.options.liveProgressTimeoutMs)
    // Admission can occur after a startup prime failure or while bindings are
    // refreshing. Reassert this exact ledger session as a live-subscription
    // demand so the first HRC event can claim the retained placeholder.
    this.options.live.ensureLiveSubscriptionForSessionRef(inFlight.sessionRef, inFlight.projectId)

    const current = this.ledgerInFlightsByRoomUuid.get(inFlight.roomUuid) ?? []
    current.push(inFlight)
    this.ledgerInFlightsByRoomUuid.set(inFlight.roomUuid, current)
    log.info('gw.discord.ledger_in_flight.started', {
      trace: { gatewayId: this.options.gatewayId, projectId: inFlight.projectId },
      data: {
        roomUuid: inFlight.roomUuid,
        roomKey: inFlight.roomKey,
        bindingId: inFlight.bindingId,
        inputEnvelopeId: inFlight.inputEnvelopeId,
      },
    })
  }

  private ledgerInFlightsForReply(
    sink: Extract<DiscordLedgerSink, { kind: 'human-notice' }>
  ): LedgerInFlight[] {
    const replyMessageSeq = sink.envelope.messageSeq
    const replyCreatedAt = Date.parse(sink.envelope.createdAt)
    return (this.ledgerInFlightsByRoomUuid.get(sink.route.roomUuid) ?? []).filter((inFlight) => {
      if (inFlight.bindingId !== sink.route.bindingId) return false
      return inFlight.inputMessageSeq !== undefined
        ? replyMessageSeq > inFlight.inputMessageSeq
        : Number.isFinite(replyCreatedAt) && replyCreatedAt >= inFlight.pendingSince - 1_000
    })
  }

  async retireFailedLedgerInFlight(envelope: import('@wrkq/client').WrkqEnvelope): Promise<void> {
    for (const inFlight of this.ledgerInFlightsByRoomUuid.get(envelope.roomUuid) ?? []) {
      if (inFlight.inputEnvelopeId === envelope.id) {
        await this.retireLedgerInFlight(inFlight, `envelope_${envelope.state}`, {
          notice: `Reply failed (${envelope.failureReason ?? envelope.state}) — full details: wrkc show ${envelope.id}`,
        })
      }
    }
  }

  async showLedgerHumanDeliveryFailure(
    sink: Extract<DiscordLedgerSink, { kind: 'human-notice' }>,
    reason: string
  ): Promise<void> {
    const notice = `reply delivery failed (${reason}) — full text: wrkc show ${sink.envelope.id}`
    let shown = false
    for (const inFlight of this.ledgerInFlightsForReply(sink)) {
      shown =
        (await this.retireLedgerInFlight(inFlight, 'human_notice_delivery_failed', {
          notice,
        })) || shown
    }
    if (shown) return

    try {
      await this.options.webhooks.send(
        sink.channelId,
        { ...sink.payload, content: `⚠️ ${notice}` },
        { maxRateLimitAttempts: this.options.maxRateLimitAttempts }
      )
      return
    } catch (error) {
      log.warn('gw.ledger_human_egress.failure_stub_webhook_error', {
        trace: { gatewayId: this.options.gatewayId },
        data: { envelopeId: sink.envelope.id, channelId: sink.channelId },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }

    const channel = await this.options.client.channels.fetch(sink.channelId)
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${sink.channelId} cannot post delivery failure stub`)
    }
    await channel.send(`⚠️ ${notice}`)
  }

  async retireLedgerInFlight(
    inFlight: LedgerInFlight,
    reason: string,
    options: {
      deletePlaceholder?: boolean | undefined
      notice?: string | undefined
    }
  ): Promise<boolean> {
    this.removeLedgerInFlight(inFlight, reason)
    this.options.pending.removePendingPlaceholder(inFlight.placeholder, reason)
    if (options.notice !== undefined) {
      return this.options.output.failPlaceholder(inFlight.placeholder.ui, options.notice)
    }
    if (options.deletePlaceholder) {
      await this.options.output.deletePlaceholder(inFlight.placeholder.ui)
    }
    return true
  }

  private removeLedgerInFlight(inFlight: LedgerInFlight, reason: string): void {
    const current = this.ledgerInFlightsByRoomUuid.get(inFlight.roomUuid)
    if (current === undefined || !current.includes(inFlight)) return
    const next = current.filter((candidate) => candidate !== inFlight)
    if (next.length > 0) {
      this.ledgerInFlightsByRoomUuid.set(inFlight.roomUuid, next)
    } else {
      this.ledgerInFlightsByRoomUuid.delete(inFlight.roomUuid)
    }
    if (inFlight.placeholder.ledgerInFlight === inFlight) {
      inFlight.placeholder.ledgerInFlight = undefined
    }
    this.clearLedgerInFlight(inFlight)
    log.info('gw.discord.ledger_in_flight.retired', {
      trace: { gatewayId: this.options.gatewayId, projectId: inFlight.projectId },
      data: {
        reason,
        roomUuid: inFlight.roomUuid,
        roomKey: inFlight.roomKey,
        bindingId: inFlight.bindingId,
        inputEnvelopeId: inFlight.inputEnvelopeId,
      },
    })
  }

  private clearLedgerInFlight(inFlight: LedgerInFlight): void {
    if (inFlight.timeout !== undefined) {
      clearTimeout(inFlight.timeout)
      inFlight.timeout = undefined
    }
  }
}
