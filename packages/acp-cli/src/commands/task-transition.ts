import type { EvidenceInput } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  readMultiStringFlag,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawAcpRequester,
  getClientFactory,
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

function normalizeActorId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('agent:')) {
    return trimmed.slice('agent:'.length)
  }
  return trimmed
}

function parseEvidence(values: string[]): EvidenceInput[] | undefined {
  const evidence: EvidenceInput[] = []
  for (const raw of values) {
    const separator = raw.indexOf('=')
    if (separator <= 0 || separator === raw.length - 1) {
      throw new CliUsageError('--evidence must use kind=ref')
    }
    evidence.push({
      kind: raw.slice(0, separator),
      ref: raw.slice(separator + 1),
    })
  }
  return evidence.length === 0 ? undefined : evidence
}

export async function runTaskTransitionCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--transition',
      '--actor',
      '--as',
      '--role',
      '--expected-version',
      '--context-hash',
      '--idempotency-key',
      '--run',
      '--server',
    ],
    multiStringFlags: ['--evidence', '--evidence-ref', '--waiver-ref'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const asValue = readStringFlag(parsed, '--as')
  const actorValue = readStringFlag(parsed, '--actor')
  const rawActor = asValue ?? actorValue
  const actorAgentId = requireActorAgentId(
    rawActor !== undefined ? normalizeActorId(rawActor) : undefined,
    env
  )
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')

  // If --expected-version is omitted, fetch the wrkf instance revision.
  let expectedTaskVersion: number
  const expectedVersionRaw = readStringFlag(parsed, '--expected-version')
  if (expectedVersionRaw !== undefined) {
    expectedTaskVersion = parseIntegerValue('--expected-version', expectedVersionRaw, { min: 0 })
  } else {
    const requester = createRawAcpRequester({
      serverUrl,
      actorAgentId,
      fetchImpl: deps.fetchImpl,
    })
    const taskSnapshot = await requester.requestJson<{
      instance: { revision: number }
    }>({
      method: 'GET',
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
    })
    expectedTaskVersion = taskSnapshot.instance.revision
  }

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.transitionTask({
    actorAgentId,
    taskId,
    transitionId: requireStringFlag(parsed, '--transition'),
    role: requireStringFlag(parsed, '--role'),
    expectedTaskVersion,
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(readStringFlag(parsed, '--context-hash') !== undefined
      ? { contextHash: readStringFlag(parsed, '--context-hash') }
      : {}),
    ...(parseEvidence(readMultiStringFlag(parsed, '--evidence')) !== undefined
      ? { inlineEvidence: parseEvidence(readMultiStringFlag(parsed, '--evidence')) }
      : {}),
    ...(readMultiStringFlag(parsed, '--evidence-ref').length > 0
      ? { evidenceRefs: readMultiStringFlag(parsed, '--evidence-ref') }
      : {}),
    ...(readMultiStringFlag(parsed, '--waiver-ref').length > 0
      ? { waiverRefs: readMultiStringFlag(parsed, '--waiver-ref') }
      : {}),
    ...(readStringFlag(parsed, '--run') !== undefined
      ? { runId: readStringFlag(parsed, '--run') }
      : {}),
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  return asText(
    `Transitioned ${response.task.taskId} via ${response.event.payload['transitionId']} to ${response.task.state.status}${response.task.state.phase === undefined ? '' : `/${response.task.state.phase}`}`
  )
}
