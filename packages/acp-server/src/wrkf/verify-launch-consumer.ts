import { basename, dirname } from 'node:path'

import type { SessionRef } from 'agent-scope'

import type { WrkfActionLaunchDeps } from './action-launch.js'
import { launchAction } from './action-launch.js'
import type { AcpWrkfWorkflowPort } from './port.js'
import { isRecord, readOptionalString, readRecord } from './value.js'

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
  const effectClaim = readClaimResponse(
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
  for (const effect of effectClaim.effects) {
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
    const taskId = readOptionalString(effect.payload, 'task') ?? input.taskId
    const idempotencyKey = buildVerifyActionIdempotencyKey({
      taskId: input.taskId,
      sourceImplementActionRunId,
      effectId: effect.effectId,
    })
    const claimedAction = await maybeClaimVerifyAction(deps, {
      taskId,
      action,
      role,
      sessionRef,
      sourceImplementActionRunId,
      effectId: effect.effectId,
      idempotencyKey,
    })
    const result = await launchAction(deps, {
      taskId,
      action,
      role,
      actor: { kind: 'agent', id: readVerifyAgentId(sessionRef) },
      lane: sessionRef.laneRef,
      idempotencyKey,
      sessionRef,
      stdinJson: { sourceImplementActionRunId },
      ...(claimedAction !== undefined ? { claimedAction } : {}),
    })
    launched += result.replay ? 0 : 1

    await deps.wrkf.effect.ack({
      effectId: effect.effectId,
      leaseToken: effectClaim.leaseToken,
    })
    acked += 1
  }

  return { claimed: effectClaim.effects.length, launched, acked }
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

async function maybeClaimVerifyAction(
  deps: ConsumeVerifyLaunchDeps,
  input: {
    taskId: string
    action: string
    role: string
    sessionRef: SessionRef
    sourceImplementActionRunId: string
    effectId: string
    idempotencyKey: string
  }
): Promise<
  | { actionRun: Record<string, unknown>; authority?: Record<string, unknown> | undefined }
  | undefined
> {
  const claimAction = deps.wrkf.action.claim
  if (claimAction === undefined) {
    return undefined
  }
  let raw: unknown
  try {
    raw = await claimAction({
      task: input.taskId,
      prefer: { action: input.action },
      runnerId: `acp-verify-launch:${input.taskId}:${input.sourceImplementActionRunId}`,
      agentRef: `agent:${readVerifyAgentId(input.sessionRef)}`,
      scopeRef: input.sessionRef.scopeRef,
      capabilities: [{ actions: [input.action], roles: [input.role] }],
      leaseMs: DEFAULT_LEASE_MS,
      idempotencyKey: input.idempotencyKey,
    })
  } catch (error) {
    if (isActionClaimUnavailable(error)) {
      return undefined
    }
    throw error
  }

  const result = isRecord(raw) ? raw : undefined
  const binding = result !== undefined ? readRecord(result['binding']) : undefined
  if (binding === undefined) {
    return undefined
  }
  const run = readRecord(binding['run'])
  if (run === undefined) {
    throw new Error('wrkf.action.claim binding.run must be an object')
  }
  const actionRunId =
    readOptionalString(run, 'id') ??
    readOptionalString(run, 'actionRunId') ??
    readOptionalString(run, 'runId')
  if (actionRunId === undefined) {
    throw new Error('wrkf.action.claim binding.run.id must be a non-empty string')
  }
  const role = readOptionalString(run, 'role') ?? input.role
  const actionRun = {
    ...run,
    actionRunId,
    runId: actionRunId,
    task: input.taskId,
    action: readOptionalString(run, 'action') ?? input.action,
    role,
    ...(readClaimWorkflowRef(binding) !== undefined
      ? { workflowRef: readClaimWorkflowRef(binding) }
      : {}),
  }
  return {
    actionRun,
    ...(readRecord(binding['authority']) !== undefined
      ? { authority: readRecord(binding['authority']) }
      : {}),
  }
}

function readClaimWorkflowRef(binding: Record<string, unknown>): string | undefined {
  const instance = readRecord(binding['instance'])
  if (instance === undefined) {
    return undefined
  }
  const template = readRecord(instance['template'])
  if (template !== undefined) {
    const id = readOptionalString(template, 'id')
    const version = readOptionalString(template, 'version')
    if (id !== undefined) {
      return version !== undefined ? `${id}@${version}` : id
    }
  }
  const templateId = readOptionalString(instance, 'templateId')
  const templateVersion = readOptionalString(instance, 'templateVersion')
  if (templateId !== undefined) {
    return templateVersion !== undefined ? `${templateId}@${templateVersion}` : templateId
  }
  return undefined
}

function isActionClaimUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    text.includes('method not found') ||
    text.includes('unknown method') ||
    text.includes('not registered')
  )
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
