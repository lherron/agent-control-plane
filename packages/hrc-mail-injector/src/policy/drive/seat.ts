/**
 * The seat's own observed turn state, and what its driver will accept.
 *
 * Read from the BROKER, never from an HRC run row. Human-typed pane turns mint
 * no HRC run (the failed first cut of T-07890) while the broker observes both
 * those turns and HRC-driven ones, so the seat probe is the one busy/idle
 * authority — and D2 turns on exactly that distinction, because the whole point
 * of steering is to reach a reader who is mid-turn however that turn began.
 *
 * `steerCapable` comes from the FROZEN broker hello capability projection on the
 * active invocation, not from published driver code: a headless runtime owns a
 * long-lived broker process that survives HRC restarts, so an installed upgrade
 * does not change what the broker in front of this seat can actually do.
 */
import type { HrcSessionRecord } from 'hrc-core'

import type { MailKickerContext } from '../context.js'
import type { KickerProbeDiagnostic } from '../contracts.js'
import { isRuntimeUnavailableStatus } from '../internal.js'

export type ObservedBrokerSeat =
  | { state: 'absent' }
  | {
      state: 'unavailable'
      runtimeId: string
      invocationId: string | null
      generation: number
      probeDiagnostic: KickerProbeDiagnostic
    }
  | { state: 'idle'; runtimeId: string; steerCapable: boolean }
  | { state: 'turn-active'; runtimeId: string; turnId: string; steerCapable: boolean }
  | { state: 'turn-observed'; runtimeId: string; turnId: string }
  | { state: 'starting' | 'stopping' | 'terminal'; runtimeId: string }

export function seatCanDispatch(seat: ObservedBrokerSeat): boolean {
  return seat.state === 'idle' || seat.state === 'absent'
}

/** Does the broker in front of this runtime advertise the `steer` admission class? */
export async function runtimeAdvertisesSteer(
  server: MailKickerContext,
  runtimeId: string
): Promise<boolean> {
  return (await server.port.seat(runtimeId)).admissionClasses?.includes('steer') ?? false
}

export async function observeBrokerSeat(
  server: MailKickerContext,
  session: HrcSessionRecord
): Promise<ObservedBrokerSeat> {
  const runtime = (await server.port.runtimesByHostSession(session.hostSessionId))
    .filter(
      (candidate) =>
        candidate.generation === session.generation &&
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
  if (runtime === undefined) return { state: 'absent' }
  const probe = await server.port.seat(runtime.runtimeId)
  if (probe.probe === null) {
    return {
      state: 'unavailable',
      runtimeId: runtime.runtimeId,
      invocationId: probe.invocationId,
      generation: probe.generation,
      probeDiagnostic: normalizeProbeDiagnostic(probe.probeError),
    }
  }
  const seat = probe.probe.seat
  return seat.state === 'turn-active'
    ? {
        state: 'turn-active',
        runtimeId: runtime.runtimeId,
        turnId: String(seat.turnId),
        steerCapable: await runtimeAdvertisesSteer(server, runtime.runtimeId),
      }
    : seat.state === 'turn-observed'
      ? {
          state: 'turn-observed',
          runtimeId: runtime.runtimeId,
          turnId: String(seat.turnId),
        }
      : seat.state === 'idle'
        ? {
            state: 'idle',
            runtimeId: runtime.runtimeId,
            steerCapable: await runtimeAdvertisesSteer(server, runtime.runtimeId),
          }
        : { state: seat.state, runtimeId: runtime.runtimeId }
}

const MAX_PROBE_MESSAGE_LENGTH = 240

/** Keep upstream failure facts useful without allowing socket payloads into logs/state. */
export function normalizeProbeDiagnostic(
  probeError: { code: string; message: string } | null
): KickerProbeDiagnostic {
  if (probeError === null) {
    return {
      boundary: 'broker_probe',
      code: 'missing_probe_diagnostic',
      message: 'HRC returned a null seat probe without a diagnostic',
      phase: 'seat_probe',
      retryable: null,
      transport: null,
      missing: true,
    }
  }
  const code = boundedText(probeError.code, 80) || 'unknown_probe_error'
  const message =
    boundedText(probeError.message, MAX_PROBE_MESSAGE_LENGTH) || 'no probe message supplied'
  return {
    boundary: 'broker_probe',
    code,
    message,
    phase: 'seat_probe',
    // The current HRC wire contract does not expose retryability or transport
    // category.  Null is deliberately distinct from a guessed value.
    retryable: null,
    transport: null,
    missing: false,
  }
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 13))}…[truncated]`
}
