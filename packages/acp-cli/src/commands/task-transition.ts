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
  getClientFactory,
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

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
      '--role',
      '--expected-version',
      '--context-hash',
      '--idempotency-key',
      '--run',
      '--server',
    ],
    multiStringFlags: ['--evidence'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.transitionTask({
    actorAgentId,
    taskId: requireStringFlag(parsed, '--task'),
    transitionId: requireStringFlag(parsed, '--transition'),
    role: requireStringFlag(parsed, '--role'),
    expectedTaskVersion: parseIntegerValue(
      '--expected-version',
      requireStringFlag(parsed, '--expected-version'),
      { min: 0 }
    ),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(readStringFlag(parsed, '--context-hash') !== undefined
      ? { contextHash: readStringFlag(parsed, '--context-hash') }
      : {}),
    ...(parseEvidence(readMultiStringFlag(parsed, '--evidence')) !== undefined
      ? { inlineEvidence: parseEvidence(readMultiStringFlag(parsed, '--evidence')) }
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
