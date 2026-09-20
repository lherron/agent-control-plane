import { Database } from 'bun:sqlite'

import { HrcMailDeliveryRepository } from 'hrc-store-sqlite'
import type { HrcMailPresentation } from 'hrc-store-sqlite'

import type { WrkqEnvelope } from './policy/ledger/types.js'
import { createWrkqLedger } from './wrkq-ledger.js'

const ENVELOPE_ID = /^EN-\d+$/i

type LedgerRead = { ok: true; envelope: WrkqEnvelope } | { ok: false; error: string }

/**
 * Read the injector-owned facts for one envelope together with wrkq's
 * authoritative envelope row. This is intentionally read-only: it explains a
 * hold but never clears, retries, or otherwise mutates one.
 */
export async function inspectMailEnvelope(input: {
  statePath: string
  envelopeId: string
}): Promise<Record<string, unknown>> {
  const envelopeId = input.envelopeId.trim().toUpperCase()
  if (!ENVELOPE_ID.test(envelopeId)) {
    throw new Error(`invalid envelope id ${JSON.stringify(input.envelopeId)}; expected EN-xxxxx`)
  }

  const sqlite = new Database(input.statePath, { readonly: true })
  let presentations: HrcMailPresentation[]
  try {
    presentations = new HrcMailDeliveryRepository(sqlite).presentationsForEnvelope(envelopeId)
  } finally {
    sqlite.close()
  }

  let ledger: LedgerRead
  try {
    ledger = { ok: true, envelope: await createWrkqLedger().envelopeShow({ envelope: envelopeId }) }
  } catch (error) {
    ledger = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const local = presentations.map((presentation) => ({
    runtimeId: presentation.runtimeId,
    presentationId: presentation.presentationId,
    landedAt: presentation.landedAt,
    reminder: {
      armedAt: presentation.reminderArmedAt ?? null,
      dueAt: presentation.reminderDueAt ?? null,
      landedAt: presentation.reminderLandedAt ?? null,
      landingHrcSeq: presentation.reminderLandingHrcSeq ?? null,
    },
    disposition: presentation.disposition ?? null,
    disposedAt: presentation.disposedAt ?? null,
  }))
  const hold = presentations.find(
    (presentation) => presentation.disposition === 'held:awaiting_operator'
  )
  const envelope = ledger.ok ? ledger.envelope : undefined
  const terminalReason = envelope === undefined ? undefined : readTerminalReason(envelope)

  return {
    envelopeId,
    inspectedAt: new Date().toISOString(),
    ledger: ledger.ok
      ? {
          ok: true,
          state: envelope?.state,
          terminal: envelope?.terminal,
          ...(terminalReason === undefined ? {} : { terminalReason }),
        }
      : { ok: false, error: ledger.error },
    presentations: local,
    verdict:
      envelope?.terminal === true
        ? { code: 'ledger_terminal', line: `ledger terminal: ${terminalReason ?? envelope.state}` }
        : hold !== undefined
          ? {
              code: 'held:awaiting_operator',
              line: `held:awaiting_operator on ${hold.runtimeId}; reply, defer, or operator ack remains ledger-authoritative`,
            }
          : { code: 'no_hold', line: 'no held:awaiting_operator local disposition' },
  }
}

function readTerminalReason(envelope: WrkqEnvelope): string | undefined {
  if (envelope.failureReason !== undefined) return envelope.failureReason
  if (envelope.reason !== undefined) return envelope.reason
  const candidate = envelope as WrkqEnvelope & {
    ackReason?: unknown
    acknowledgementReason?: unknown
  }
  if (typeof candidate.ackReason === 'string') return candidate.ackReason
  if (typeof candidate.acknowledgementReason === 'string') return candidate.acknowledgementReason
  return undefined
}
