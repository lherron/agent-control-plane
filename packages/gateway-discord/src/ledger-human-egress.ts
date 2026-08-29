import type { WorkClient, WrkqEnvelope } from '@wrkq/client'
import type {
  DiscordLedgerDelivery,
  DiscordLedgerProjectionRoute,
  InterfaceStore,
  RecordDiscordLedgerProjectionRouteInput,
} from 'acp-interface-store'
import { conversationRefToChannelId, threadRefToThreadId } from './bindings.js'
import { actorSlug, avatarFor, formatScopeHandleDisplay } from './identity.js'
import { isTaskboardTaskId, taskboardTaskUrl } from './taskboard-links.js'
import type { WebhookPayload } from './webhooks.js'

type MonitorEvent = {
  id: number
  timestamp: string
  resource_id?: string | undefined
  event_type: string
  payload?: string | undefined
}

type MonitorEventsPage = {
  items: MonitorEvent[]
  high_water: number
}

type EnvelopeCreatedPayload = {
  id?: string | undefined
  room_uuid?: string | undefined
  to_principal_ref?: string | undefined
  to_scope_ref?: string | undefined
}

export type DiscordLedgerHumanEgressDeps = {
  gatewayId: string
  client: WorkClient
  store: InterfaceStore
  controlPlaneChannelId?: string | undefined
  maxDeliveryAttempts: number
  resolveRoomProjectId?(roomUuid: string): Promise<string | undefined>
  findRecentMessageId(channelId: string, envelopeId: string): Promise<string | undefined>
  send(sink: DiscordLedgerSink): Promise<{ messageId: string }>
}

const PAGE_LIMIT = 200
const EMBED_TITLE_MAX = 256
const EMBED_DESCRIPTION_MAX = 4096

export type DiscordLedgerSink =
  | {
      kind: 'mirror'
      channelId: string
      payload: WebhookPayload
      envelope: WrkqEnvelope
    }
  | {
      kind: 'human-notice'
      channelId: string
      payload: WebhookPayload
      envelope: WrkqEnvelope
      route: DiscordLedgerProjectionRoute
    }

export type ResolveEnvelopeSinksOptions = {
  controlPlaneChannelId?: string | undefined
  projectId?: string | undefined
  route?: DiscordLedgerProjectionRoute | undefined
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function displayParty(party: WrkqEnvelope['from']): string {
  return party.scopeRef === undefined
    ? party.principalRef
    : formatScopeHandleDisplay(party.scopeRef)
}

function mirrorGlyph(envelope: WrkqEnvelope): string {
  if (envelope.to === null || envelope.obligation === 'none') return '·'
  return envelope.obligation === 'reply_required' ? '↪' : '▸'
}

function mirrorColor(envelope: WrkqEnvelope): number {
  if (envelope.to === null || envelope.obligation === 'none') return 0x4b5563
  return envelope.obligation === 'reply_required' ? 0xe0a23c : 0x7c8595
}

/** Pure Sink-A render: one dense ledger line with the speaking agent carried by
 * the webhook identity. */
export function chatCard(envelope: WrkqEnvelope, projectId: string | undefined): WebhookPayload {
  const addressee = envelope.to === null ? 'room' : displayParty(envelope.to)
  const taskId =
    envelope.taskId ?? (isTaskboardTaskId(envelope.roomKey) ? envelope.roomKey : undefined)
  const subtext = [envelope.roomKey, projectId ?? 'unknown', envelope.id]
  if (projectId !== undefined && taskId !== undefined) {
    subtext.push(`[Open task](${taskboardTaskUrl(projectId, taskId)})`)
  }
  const description = truncate(
    `-# ${subtext.join(' . ')}\n\n${envelope.body}`,
    EMBED_DESCRIPTION_MAX
  )

  return {
    username: displayParty(envelope.from),
    avatar_url: avatarFor(actorSlug(envelope.from.principalRef)),
    embeds: [
      {
        title: truncate(`${mirrorGlyph(envelope)} -> ${addressee}`, EMBED_TITLE_MAX),
        color: mirrorColor(envelope),
        description,
      },
    ],
  }
}

/** Pure Sink-B render. The EN id is intentionally live even when Sink A is
 * disabled: it is the reconciliation/readback key for every new notice. */
export function humanNotice(envelope: WrkqEnvelope): WebhookPayload {
  return {
    content: `-# ${displayParty(envelope.from)} . ${envelope.id}\n${envelope.body}`,
  }
}

function humanNoticeChannelId(route: DiscordLedgerProjectionRoute): string | undefined {
  return threadRefToThreadId(route.threadRef) ?? conversationRefToChannelId(route.conversationRef)
}

/** Pure routing decision. Mirror and human notice are additive, never
 * precedence rungs; provenance and idempotency metadata are deliberately not
 * consulted. */
export function resolveEnvelopeSinks(
  envelope: WrkqEnvelope,
  options: ResolveEnvelopeSinksOptions
): DiscordLedgerSink[] {
  const sinks: DiscordLedgerSink[] = []
  if (options.controlPlaneChannelId !== undefined) {
    sinks.push({
      kind: 'mirror',
      channelId: options.controlPlaneChannelId,
      payload: chatCard(envelope, options.projectId),
      envelope,
    })
  }

  const route = options.route
  const humanChannelId = route === undefined ? undefined : humanNoticeChannelId(route)
  if (
    route !== undefined &&
    humanChannelId !== undefined &&
    envelope.to !== null &&
    envelope.to.scopeRef === undefined &&
    route.humanPrincipalRef === envelope.to.principalRef &&
    !alreadyPresentedToDiscord(envelope)
  ) {
    sinks.push({
      kind: 'human-notice',
      channelId: humanChannelId,
      payload: humanNotice(envelope),
      envelope,
      route,
    })
  }
  return sinks
}

function decodeCreatedPayload(event: MonitorEvent): EnvelopeCreatedPayload | undefined {
  if (event.event_type !== 'envelope.created' || event.payload === undefined) return undefined
  try {
    const value = JSON.parse(event.payload) as unknown
    return typeof value === 'object' && value !== null
      ? (value as EnvelopeCreatedPayload)
      : undefined
  } catch {
    return undefined
  }
}

function alreadyPresentedToDiscord(envelope: WrkqEnvelope): boolean {
  return envelope.presentedTo.some((receipt) => receipt.deliveryOutcome === 'discord')
}

/** Durable wrkq-ledger tail that fans room envelopes out to Discord sinks. */
export class DiscordLedgerEgress {
  private readonly roomProjectIds = new Map<string, Promise<string | undefined>>()

  constructor(private readonly deps: DiscordLedgerHumanEgressDeps) {}

  recordRoute(input: Omit<RecordDiscordLedgerProjectionRouteInput, 'gatewayId'>): void {
    this.deps.store.discordLedgerProjection.recordRoute({
      ...input,
      gatewayId: this.deps.gatewayId,
    })
  }

  pruneBindings(activeBindingIds: readonly string[]): void {
    this.deps.store.discordLedgerProjection.pruneBindings(this.deps.gatewayId, activeBindingIds)
    this.deps.store.discordLedgerDeliveries.pruneBindings(this.deps.gatewayId, activeBindingIds)
  }

  /** Reconcile sends that may have reached Discord before their terminal write.
   * This runs before the ledger cursor resumes, so a miss can consume at most
   * one additional durable attempt per startup reconciliation pass. */
  async reconcileAttempting(): Promise<number> {
    const attempting = this.deps.store.discordLedgerDeliveries.listAttempting(this.deps.gatewayId)
    const failures: unknown[] = []

    for (const delivery of attempting) {
      try {
        const foundMessageId = await this.deps.findRecentMessageId(
          delivery.channelId,
          delivery.envelopeId
        )
        if (foundMessageId !== undefined) {
          this.deps.store.discordLedgerDeliveries.markSent(delivery, foundMessageId)
          await this.recordHumanPresentation(delivery, foundMessageId)
          continue
        }

        const sink = await this.hydrateDeliverySink(delivery)
        if (sink === undefined) {
          this.deps.store.discordLedgerDeliveries.markFailed(delivery, 'sink_unresolvable')
          continue
        }
        await this.driveSink(sink)
      } catch (error) {
        failures.push(error)
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Discord ledger startup reconciliation failed')
    }
    return attempting.length
  }

  async initializeCursor(): Promise<number> {
    const existing = this.deps.store.discordLedgerProjection.getCursor(this.deps.gatewayId)
    if (existing !== undefined) return existing

    const beforeLast = await this.eventsView({ cursor: 0, lastN: 1 })
    const start = Math.max(beforeLast.high_water, 0)
    const end = await this.eventsView({ cursor: start, limit: 1 })
    return this.deps.store.discordLedgerProjection.advanceCursor(
      this.deps.gatewayId,
      Math.max(end.high_water, start)
    )
  }

  async pollOnce(): Promise<number> {
    const cursor = await this.initializeCursor()
    const page = await this.eventsView({
      cursor,
      eventTypes: ['envelope.created'],
      limit: PAGE_LIMIT,
    })

    let advanced = cursor
    for (const event of page.items) {
      await this.projectEvent(event)
      advanced = this.deps.store.discordLedgerProjection.advanceCursor(
        this.deps.gatewayId,
        event.id
      )
    }
    if (advanced < page.high_water) {
      advanced = this.deps.store.discordLedgerProjection.advanceCursor(
        this.deps.gatewayId,
        page.high_water
      )
    }
    return advanced
  }

  private async projectEvent(event: MonitorEvent): Promise<void> {
    const payload = decodeCreatedPayload(event)
    if (payload?.id === undefined || payload.room_uuid === undefined) {
      return
    }

    const route =
      payload.to_principal_ref !== undefined && payload.to_scope_ref === undefined
        ? this.deps.store.discordLedgerProjection.getRoute(this.deps.gatewayId, payload.room_uuid)
        : undefined
    const hasHumanSink = route?.humanPrincipalRef === payload.to_principal_ref
    if (this.deps.controlPlaneChannelId === undefined && !hasHumanSink) return

    const envelope = await this.deps.client.wrkq.envelope.show({
      envelope: payload.id,
    })
    const projectId =
      this.deps.controlPlaneChannelId === undefined
        ? undefined
        : await this.roomProjectId(payload.room_uuid)
    const sinks = resolveEnvelopeSinks(envelope, {
      ...(this.deps.controlPlaneChannelId !== undefined
        ? { controlPlaneChannelId: this.deps.controlPlaneChannelId }
        : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(hasHumanSink && route !== undefined ? { route } : {}),
    })

    const failures: unknown[] = []
    for (const sink of sinks) {
      try {
        await this.driveSink(sink)
      } catch (error) {
        failures.push(error)
      }
    }

    const deliveries = this.deps.store.discordLedgerDeliveries.listByEnvelope(
      this.deps.gatewayId,
      envelope.id
    )
    const everySelectedSinkIsTerminal = sinks.every((sink) =>
      deliveries.some(
        (delivery) =>
          delivery.sink === sink.kind && (delivery.state === 'sent' || delivery.state === 'failed')
      )
    )
    if (!everySelectedSinkIsTerminal || failures.length > 0) {
      throw new AggregateError(failures, `Discord ledger egress failed for ${envelope.id}`)
    }
  }

  private async driveSink(sink: DiscordLedgerSink): Promise<void> {
    const claim = this.deps.store.discordLedgerDeliveries.beginAttempt({
      gatewayId: this.deps.gatewayId,
      envelopeId: sink.envelope.id,
      sink: sink.kind,
      channelId: sink.channelId,
      ...(sink.kind === 'human-notice' ? { bindingId: sink.route.bindingId } : {}),
      maxAttempts: this.deps.maxDeliveryAttempts,
    })
    if (claim.outcome !== 'attempting') return

    let sent: { messageId: string }
    try {
      sent = await this.deps.send(sink)
    } catch (error) {
      if (claim.delivery.attempts >= this.deps.maxDeliveryAttempts) {
        this.deps.store.discordLedgerDeliveries.markFailed(
          claim.delivery,
          error instanceof Error ? error.message : String(error)
        )
        return
      }
      throw error
    }

    this.deps.store.discordLedgerDeliveries.markSent(claim.delivery, sent.messageId)
    if (sink.kind === 'human-notice') {
      await this.presentHumanNotice(sink.envelope.id, sink.route.humanPrincipalRef, sent.messageId)
    }
  }

  private async hydrateDeliverySink(
    delivery: DiscordLedgerDelivery
  ): Promise<DiscordLedgerSink | undefined> {
    const envelope = await this.deps.client.wrkq.envelope.show({
      envelope: delivery.envelopeId,
    })
    if (delivery.sink === 'mirror') {
      return {
        kind: 'mirror',
        channelId: delivery.channelId,
        payload: chatCard(envelope, await this.roomProjectId(envelope.roomUuid)),
        envelope,
      }
    }
    if (delivery.sink !== 'human-notice') return undefined

    const route = this.deps.store.discordLedgerProjection.getRoute(
      this.deps.gatewayId,
      envelope.roomUuid
    )
    if (route === undefined || route.bindingId !== delivery.bindingId) return undefined
    return {
      kind: 'human-notice',
      channelId: delivery.channelId,
      payload: humanNotice(envelope),
      envelope,
      route,
    }
  }

  private async recordHumanPresentation(
    delivery: DiscordLedgerDelivery,
    messageId: string
  ): Promise<void> {
    if (delivery.sink !== 'human-notice') return
    const envelope = await this.deps.client.wrkq.envelope.show({
      envelope: delivery.envelopeId,
    })
    const route = this.deps.store.discordLedgerProjection.getRoute(
      this.deps.gatewayId,
      envelope.roomUuid
    )
    if (route === undefined || route.bindingId !== delivery.bindingId) return
    await this.presentHumanNotice(envelope.id, route.humanPrincipalRef, messageId)
  }

  private async presentHumanNotice(
    envelopeId: string,
    humanPrincipalRef: string,
    messageId: string
  ): Promise<void> {
    await this.deps.client.wrkq.envelope.present({
      envelope: envelopeId,
      memberRef: humanPrincipalRef,
      principalRef: 'agent:gateway-discord',
      driveAttemptId: messageId,
      deliveryOutcome: 'discord',
    })
  }

  private roomProjectId(roomUuid: string): Promise<string | undefined> {
    const cached = this.roomProjectIds.get(roomUuid)
    if (cached !== undefined) return cached

    const resolved = this.resolveRoomProjectId(roomUuid).catch(() => undefined)
    this.roomProjectIds.set(roomUuid, resolved)
    return resolved
  }

  private async resolveRoomProjectId(roomUuid: string): Promise<string | undefined> {
    if (this.deps.resolveRoomProjectId !== undefined) {
      return this.deps.resolveRoomProjectId(roomUuid)
    }
    const room = await this.deps.client.wrkq.room.show({ room: roomUuid })
    const projectId = room.workRef?.path.split('/').find((part) => part.length > 0)
    return projectId
  }

  private eventsView(params: {
    cursor: number
    eventTypes?: string[] | undefined
    limit?: number | undefined
    lastN?: number | undefined
  }): Promise<MonitorEventsPage> {
    return this.deps.client.call<MonitorEventsPage>('wrkq.monitor.eventsView', params)
  }
}

/** Compatibility export for callers migrating with the same release. */
export { DiscordLedgerEgress as DiscordLedgerHumanEgress }
