import type { MailKickerContext } from '../context.js'
import { kickerScopeRefFor } from '../drive/authority.js'
import { hrcFacts } from '../facts/hrc-facts.js'
import { errorText } from '../internal.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'

const MAX_TIMER_MS = 2_147_483_647
const RETRY_MS = 30_000

type Deadline = { target: string; atMs: number }
type DeferredWakes = {
  deadlines: Map<string, Deadline>
  timer?: ReturnType<typeof setTimeout> | undefined
  retryAtMs: number
}
const wakes = new WeakMap<MailKickerContext, DeferredWakes>()

/** Existing envelope.deferred evidence supplies both recipient and retry clock. */
export async function observeDeferredWake(
  server: MailKickerContext,
  envelopeId: string
): Promise<void> {
  forgetDeferredWake(server, envelopeId)
  const envelope = await server.ledger.envelopeShow({ envelope: envelopeId })
  if (server.stopping || envelope.state !== 'deferred' || envelope.retryAt === undefined) return
  const scopeRef = envelope.to?.scopeRef
  if (scopeRef === undefined) return
  const target = targetSessionRefForLedgerScope(scopeRef)
  // Resolve authority on the event, never poll it while waiting for the clock.
  // The eventual drive still owns its normal fresh preflight/action fences.
  const canonicalScope = target === undefined ? undefined : kickerScopeRefFor(target)
  if (target === undefined || canonicalScope === undefined) return
  if ((await hrcFacts(server).foreignHome(canonicalScope, { fresh: true })) !== undefined) return
  if (server.stopping) return
  const atMs = Date.parse(envelope.retryAt)
  if (!Number.isFinite(atMs)) return
  let state = wakes.get(server)
  if (state === undefined) {
    state = { deadlines: new Map(), retryAtMs: 0 }
    wakes.set(server, state)
  }
  // wrkq compares due times at whole-second precision. Never consume a timer
  // before the ledger can actually repend a subsecond timestamp.
  state.deadlines.set(envelopeId, { target, atMs: Math.ceil(atMs / 1_000) * 1_000 })
  arm(server, state)
}

export function forgetDeferredWake(server: MailKickerContext, envelopeId: string): void {
  const state = wakes.get(server)
  if (state === undefined) return
  state.deadlines.delete(envelopeId)
  arm(server, state)
}

/** Cancel clocks now; the controller includes the outstanding read in its bounded drain. */
export function stopDeferredWakes(server: MailKickerContext): Promise<void> {
  const state = wakes.get(server)
  if (state?.timer !== undefined) clearTimeout(state.timer)
  state?.deadlines.clear()
  wakes.delete(server)
  return server.mailKickerDeferralWakeInFlight ?? Promise.resolve()
}

/** The existing exact timer remains the owner of repending due deferrals. */
export function nextDeferredWakeAt(server: MailKickerContext): number {
  const state = wakes.get(server)
  if (state === undefined || server.mailKickerDeferralWakeInFlight !== undefined)
    return Number.POSITIVE_INFINITY
  let next = Number.POSITIVE_INFINITY
  for (const deadline of state.deadlines.values()) next = Math.min(next, deadline.atMs)
  return Math.max(next, state.retryAtMs)
}

function arm(server: MailKickerContext, state: DeferredWakes): void {
  if (state.timer !== undefined) clearTimeout(state.timer)
  state.timer = undefined
  if (
    server.stopping ||
    server.mailKickerDeferralWakeInFlight !== undefined ||
    state.deadlines.size === 0
  )
    return
  let nextAtMs = Number.POSITIVE_INFINITY
  for (const deadline of state.deadlines.values()) nextAtMs = Math.min(nextAtMs, deadline.atMs)
  const delay = Math.max(0, Math.max(nextAtMs, state.retryAtMs) - Date.now())
  state.timer = setTimeout(
    () => {
      state.timer = undefined
      const due = [...state.deadlines].filter(([, deadline]) => deadline.atMs <= Date.now())
      if (due.length === 0) {
        arm(server, state)
        return
      }
      const operation = (async () => {
        try {
          // This existing read lazily repends due deferrals globally. Empty
          // scopes falls back to the caller; its returned items are not the due
          // set. Wake only recipients whose observed retry clock just fired.
          await server.ledger.pendingView({ scopes: [] })
          if (server.stopping) return
          const targets = new Set<string>()
          for (const [id, deadline] of due) {
            if (state.deadlines.get(id) !== deadline) continue
            state.deadlines.delete(id)
            targets.add(deadline.target)
          }
          state.retryAtMs = 0
          for (const target of targets) server.wake(target, 'periodic')
        } catch (error) {
          state.retryAtMs = Date.now() + RETRY_MS
          server.log('WARN', 'wrkq.kicker.deferral_wake_failed', { error: errorText(error) })
        }
      })().finally(() => {
        if (server.mailKickerDeferralWakeInFlight === operation)
          server.mailKickerDeferralWakeInFlight = undefined
        arm(server, state)
      })
      server.mailKickerDeferralWakeInFlight = operation
    },
    Math.min(delay, MAX_TIMER_MS)
  )
  state.timer.unref?.()
}
