import { basename, dirname } from 'node:path'

import type { SessionRef } from 'agent-scope'

import type { WrkfActionLaunchDeps } from './action-launch.js'
import { launchAction } from './action-launch.js'
import type { AcpWrkfWorkflowPort } from './port.js'
import { isRecord, readOptionalString } from './value.js'

const VERIFY_LAUNCH_KIND = 'verify_launch_intent'
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_LIMIT = 10

if (process.env['NODE_ENV'] === 'test') {
  const { expect } = await import('bun:test')
  expect.extend({
    toHaveSize(received: unknown, expected: number) {
      const size = isRecord(received) ? received['size'] : undefined
      const pass = typeof size === 'number' && size === expected
      return {
        pass,
        message: () => `expected value to have size ${expected}`,
      }
    },
  })
}

export type ConsumeVerifyLaunchDeps = WrkfActionLaunchDeps & {
  wrkf: AcpWrkfWorkflowPort
  verifyCommandSessionRef?: SessionRef | undefined
}

export type ConsumeVerifyLaunchInput = {
  taskId: string
  limit?: number | undefined
}

type ClaimedEffect = {
  effectId: string
  kind: string
  payload: Record<string, unknown>
}

export async function consumeVerifyLaunchIntents(
  deps: ConsumeVerifyLaunchDeps,
  input: ConsumeVerifyLaunchInput
): Promise<{ claimed: number; launched: number; acked: number }> {
  const claim = readClaimResponse(
    await deps.wrkf.effect.claim({
      adapter: 'acp',
      kind: VERIFY_LAUNCH_KIND,
      task: input.taskId,
      limit: input.limit ?? DEFAULT_LIMIT,
      leaseMs: DEFAULT_LEASE_MS,
    })
  )

  let launched = 0
  let acked = 0
  for (const effect of claim.effects) {
    const sourceImplementActionRunId = requirePayloadString(
      effect.payload,
      'sourceImplementActionRunId'
    )
    const action = readOptionalString(effect.payload, 'action') ?? 'verify'
    const role = readOptionalString(effect.payload, 'role') ?? 'tester'
    const sessionRef = resolveVerifySessionRef(deps, {
      payload: effect.payload,
      taskId: input.taskId,
    })
    const result = await launchAction(deps, {
      taskId: readOptionalString(effect.payload, 'task') ?? input.taskId,
      action,
      role,
      actor: { kind: 'agent', id: readVerifyAgentId(sessionRef) },
      lane: sessionRef.laneRef,
      idempotencyKey: buildVerifyActionIdempotencyKey({
        taskId: input.taskId,
        sourceImplementActionRunId,
        effectId: effect.effectId,
      }),
      sessionRef,
      stdinJson: { sourceImplementActionRunId },
    })
    launched += result.replay ? 0 : 1

    await deps.wrkf.effect.ack({
      effectId: effect.effectId,
      leaseToken: claim.leaseToken,
    })
    acked += 1
  }

  return { claimed: claim.effects.length, launched, acked }
}

function buildVerifyActionIdempotencyKey(input: {
  taskId: string
  sourceImplementActionRunId: string
  effectId: string
}): string {
  return `verify-launch:${input.taskId}:${input.sourceImplementActionRunId}:${input.effectId}`
}

function readClaimResponse(value: unknown): { effects: ClaimedEffect[]; leaseToken: string } {
  if (!isRecord(value)) {
    return { effects: [], leaseToken: '' }
  }
  const rawEffects = Array.isArray(value['effects']) ? value['effects'] : []
  const leaseToken = readOptionalString(value, 'leaseToken') ?? ''
  return {
    leaseToken,
    effects: rawEffects.flatMap((effect): ClaimedEffect[] => {
      if (!isRecord(effect)) {
        return []
      }
      const payload = isRecord(effect['payload']) ? effect['payload'] : undefined
      const effectId = readOptionalString(effect, 'effectId') ?? readOptionalString(effect, 'id')
      const kind = readOptionalString(effect, 'kind') ?? VERIFY_LAUNCH_KIND
      if (payload === undefined || effectId === undefined) {
        return []
      }
      return [{ effectId, kind, payload }]
    }),
  }
}

function resolveVerifySessionRef(
  deps: ConsumeVerifyLaunchDeps,
  input: { payload: Record<string, unknown>; taskId: string }
): SessionRef {
  const { payload } = input
  const payloadSessionRef = readSessionRef(payload['sessionRef'])
  if (payloadSessionRef !== undefined) {
    return payloadSessionRef
  }

  const scopeRef =
    readOptionalString(payload, 'scopeRef') ??
    readOptionalString(payload, 'sourceScopeRef') ??
    deps.verifyCommandSessionRef?.scopeRef
  if (scopeRef !== undefined) {
    return rawSessionRef(
      scopeRef,
      readOptionalString(payload, 'laneRef') ??
        readOptionalString(payload, 'sourceLaneRef') ??
        deps.verifyCommandSessionRef?.laneRef ??
        'main'
    )
  }

  const project = resolveProjectSlugFallback()
  const taskId = input.taskId.replace(/-red$/, '')
  return rawSessionRef(`agent:cody:project:${project}:task:${taskId}`, 'impl')
}

function readSessionRef(value: unknown): SessionRef | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const scopeRef = readOptionalString(value, 'scopeRef')
  if (scopeRef === undefined) {
    return undefined
  }
  return rawSessionRef(scopeRef, readOptionalString(value, 'laneRef') ?? 'main')
}

function readVerifyAgentId(sessionRef: SessionRef): string {
  const match = /^agent:([^:]+)/.exec(sessionRef.scopeRef)
  return match?.[1] ?? 'cody'
}

function requirePayloadString(payload: Record<string, unknown>, field: string): string {
  const value = readOptionalString(payload, field)
  if (value === undefined) {
    throw new Error(`verify-launch effect payload.${field} must be a non-empty string`)
  }
  return value
}

function rawSessionRef(scopeRef: string, laneRef: string): SessionRef {
  return { scopeRef, laneRef } as unknown as SessionRef
}

function resolveProjectSlugFallback(): string {
  const cwdBase = basename(process.cwd())
  if (cwdBase === 'acp-server') {
    return basename(dirname(dirname(process.cwd()))) || 'agent-control-plane'
  }
  return cwdBase || 'agent-control-plane'
}
