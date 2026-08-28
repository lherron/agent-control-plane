import type { WorkClient, WrkqEnvelope } from '@wrkq/client'
import type {
  DiscordLedgerProjectionRoute,
  InterfaceStore,
  RecordDiscordLedgerProjectionRouteInput,
} from 'acp-interface-store'

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
  send(input: {
    route: DiscordLedgerProjectionRoute
    envelope: WrkqEnvelope
  }): Promise<{ messageId: string }>
}

const PAGE_LIMIT = 200

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

/** Durable wrkq-ledger tail that projects human-addressed replies into Discord. */
export class DiscordLedgerHumanEgress {
  constructor(private readonly deps: DiscordLedgerHumanEgressDeps) {}

  recordRoute(input: Omit<RecordDiscordLedgerProjectionRouteInput, 'gatewayId'>): void {
    this.deps.store.discordLedgerProjection.recordRoute({
      ...input,
      gatewayId: this.deps.gatewayId,
    })
  }

  pruneBindings(activeBindingIds: readonly string[]): void {
    this.deps.store.discordLedgerProjection.pruneBindings(this.deps.gatewayId, activeBindingIds)
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
    if (
      payload?.id === undefined ||
      payload.room_uuid === undefined ||
      payload.to_principal_ref === undefined ||
      payload.to_scope_ref !== undefined
    ) {
      return
    }

    const route = this.deps.store.discordLedgerProjection.getRoute(
      this.deps.gatewayId,
      payload.room_uuid
    )
    if (route === undefined || route.humanPrincipalRef !== payload.to_principal_ref) return

    const envelope = await this.deps.client.wrkq.envelope.show({ envelope: payload.id })
    if (alreadyPresentedToDiscord(envelope)) return

    const sent = await this.deps.send({ route, envelope })
    await this.deps.client.wrkq.envelope.present({
      envelope: envelope.id,
      memberRef: route.humanPrincipalRef,
      principalRef: 'agent:gateway-discord',
      driveAttemptId: sent.messageId,
      deliveryOutcome: 'discord',
    })
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
