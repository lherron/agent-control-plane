import type {
  BeginDiscordLedgerDeliveryAttemptInput,
  BeginDiscordLedgerDeliveryAttemptResult,
  DiscordLedgerDelivery,
  DiscordLedgerDeliveryKey,
  DiscordLedgerDeliveryState,
} from '../types.js'
import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type DeliveryRow = {
  gateway_id: string
  envelope_id: string
  sink: string
  channel_id: string
  binding_id: string | null
  state: DiscordLedgerDeliveryState
  discord_message_id: string | null
  attempts: number
  failure_reason: string | null
  updated_at: string
}

const SELECT_COLUMNS = `gateway_id, envelope_id, sink, channel_id, binding_id,
                        state, discord_message_id, attempts, failure_reason, updated_at`

function mapDelivery(row: DeliveryRow): DiscordLedgerDelivery {
  return {
    gatewayId: row.gateway_id,
    envelopeId: row.envelope_id,
    sink: row.sink,
    channelId: row.channel_id,
    bindingId: toOptionalString(row.binding_id),
    state: row.state,
    discordMessageId: toOptionalString(row.discord_message_id),
    attempts: row.attempts,
    failureReason: toOptionalString(row.failure_reason),
    updatedAt: row.updated_at,
  }
}

/** Reason recorded when a row is retired because its attempt budget ran out. */
export const DELIVERY_ATTEMPTS_EXHAUSTED = 'attempts_exhausted'

/**
 * Durable per-sink delivery state for Discord's wrkq-ledger egress.
 *
 * The attempt budget is what bounds how many posts Discord can accept for one
 * (envelope, sink): `beginAttempt` consumes a unit of that budget in the same
 * durable write that marks the row `attempting`, and the caller sends only
 * afterwards. A crash between the write and the send therefore leaves the
 * budget spent, which is the point — a post Discord accepted but which was
 * never recorded still cost an attempt. No stronger claim is made: Discord
 * exposes no idempotency key, so an accepted-but-unrecorded post can be sent
 * again on the next attempt, and the guarantee is a bound rather than a count.
 */
export class DiscordLedgerDeliveryRepo {
  constructor(private readonly context: RepoContext) {}

  /**
   * Claim one attempt for (gateway, envelope, sink) and return whether the
   * caller may send.
   *
   * The claim is a SINGLE statement: it marks the row `attempting` and
   * increments `attempts` together, so the two can never be observed apart and
   * a crash cannot rewind the increment. The upsert is refused when the row is
   * already terminal, or when `attempts` has reached `maxAttempts`; the latter
   * retires the row as `failed`, and it is never resent.
   *
   * Do not call this inside `runInTransaction`: the claim has to commit before
   * the send, and an enclosing transaction would defer that commit past it.
   */
  beginAttempt(
    input: BeginDiscordLedgerDeliveryAttemptInput
  ): BeginDiscordLedgerDeliveryAttemptResult {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new Error(
        `maxDeliveryAttempts must be a positive integer, received ${String(input.maxAttempts)}`
      )
    }

    const claimed = this.context.sqlite
      .prepare(
        `INSERT INTO discord_ledger_deliveries (
           gateway_id, envelope_id, sink, channel_id, binding_id,
           state, discord_message_id, attempts, failure_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'attempting', NULL, 1, NULL, ?)
         ON CONFLICT(gateway_id, envelope_id, sink) DO UPDATE SET
           channel_id = excluded.channel_id,
           binding_id = excluded.binding_id,
           state = 'attempting',
           attempts = discord_ledger_deliveries.attempts + 1,
           failure_reason = NULL,
           updated_at = excluded.updated_at
         WHERE discord_ledger_deliveries.state = 'attempting'
           AND discord_ledger_deliveries.attempts < ?
         RETURNING ${SELECT_COLUMNS}`
      )
      .get(
        input.gatewayId,
        input.envelopeId,
        input.sink,
        input.channelId,
        input.bindingId ?? null,
        new Date().toISOString(),
        input.maxAttempts
      ) as DeliveryRow | undefined

    if (claimed !== undefined) {
      return { outcome: 'attempting', delivery: mapDelivery(claimed) }
    }

    // The write was refused, so the row exists and is not claimable.
    const existing = this.require(input)
    if (existing.state !== 'attempting') {
      return { outcome: 'terminal', delivery: existing }
    }
    return {
      outcome: 'exhausted',
      delivery: this.markFailed(input, DELIVERY_ATTEMPTS_EXHAUSTED),
    }
  }

  /** Record that Discord accepted the post for this attempt. */
  markSent(key: DiscordLedgerDeliveryKey, discordMessageId: string): DiscordLedgerDelivery {
    return this.transition(key, 'sent', { discordMessageId })
  }

  /** Retire the row; it is never resent, whatever the reason. */
  markFailed(key: DiscordLedgerDeliveryKey, reason: string): DiscordLedgerDelivery {
    return this.transition(key, 'failed', { failureReason: reason })
  }

  get(key: DiscordLedgerDeliveryKey): DiscordLedgerDelivery | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM discord_ledger_deliveries
          WHERE gateway_id = ? AND envelope_id = ? AND sink = ?`
      )
      .get(key.gatewayId, key.envelopeId, key.sink) as DeliveryRow | undefined
    return row === undefined ? undefined : mapDelivery(row)
  }

  /** Every sink recorded for one envelope, for the cursor's terminality check. */
  listByEnvelope(gatewayId: string, envelopeId: string): DiscordLedgerDelivery[] {
    return (
      this.context.sqlite
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM discord_ledger_deliveries
            WHERE gateway_id = ? AND envelope_id = ?
            ORDER BY sink`
        )
        .all(gatewayId, envelopeId) as DeliveryRow[]
    ).map(mapDelivery)
  }

  /** Rows left mid-flight by a restart, oldest first, for reconciliation. */
  listAttempting(gatewayId: string): DiscordLedgerDelivery[] {
    return (
      this.context.sqlite
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM discord_ledger_deliveries
            WHERE gateway_id = ? AND state = 'attempting'
            ORDER BY updated_at, envelope_id, sink`
        )
        .all(gatewayId) as DeliveryRow[]
    ).map(mapDelivery)
  }

  /**
   * Drop rows whose binding is gone, as the projection routes already do. Rows
   * with no binding (the channel-root mirror) are not route-scoped and are
   * left alone.
   */
  pruneBindings(gatewayId: string, activeBindingIds: readonly string[]): number {
    if (activeBindingIds.length === 0) {
      return this.context.sqlite
        .prepare(
          `DELETE FROM discord_ledger_deliveries
            WHERE gateway_id = ? AND binding_id IS NOT NULL`
        )
        .run(gatewayId).changes
    }
    const placeholders = activeBindingIds.map(() => '?').join(', ')
    return this.context.sqlite
      .prepare(
        `DELETE FROM discord_ledger_deliveries
          WHERE gateway_id = ?
            AND binding_id IS NOT NULL
            AND binding_id NOT IN (${placeholders})`
      )
      .run(gatewayId, ...activeBindingIds).changes
  }

  private transition(
    key: DiscordLedgerDeliveryKey,
    state: Exclude<DiscordLedgerDeliveryState, 'attempting'>,
    fields: { discordMessageId?: string; failureReason?: string }
  ): DiscordLedgerDelivery {
    this.context.sqlite
      .prepare(
        `UPDATE discord_ledger_deliveries
            SET state = ?,
                discord_message_id = COALESCE(?, discord_message_id),
                failure_reason = ?,
                updated_at = ?
          WHERE gateway_id = ? AND envelope_id = ? AND sink = ?`
      )
      .run(
        state,
        fields.discordMessageId ?? null,
        fields.failureReason ?? null,
        new Date().toISOString(),
        key.gatewayId,
        key.envelopeId,
        key.sink
      )
    return this.require(key)
  }

  private require(key: DiscordLedgerDeliveryKey): DiscordLedgerDelivery {
    const delivery = this.get(key)
    if (delivery === undefined) {
      throw new Error(
        `Failed to reload Discord ledger delivery ${key.gatewayId}:${key.envelopeId}:${key.sink}`
      )
    }
    return delivery
  }
}
