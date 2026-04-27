import type { EvidenceItem } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { renderTransitionApplied } from '../output/transitions-render.js'
import { normalizeRoleName } from '../roles.js'
import {
  hasFlag,
  parseArgs,
  parseCommaList,
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

function parseWaiverValues(values: string[]): EvidenceItem[] {
  const waivers: EvidenceItem[] = []
  for (const rawValue of values) {
    for (const entry of rawValue.split(',')) {
      const trimmed = entry.trim()
      if (trimmed.length === 0) {
        continue
      }

      const separator = trimmed.indexOf(':')
      if (separator <= 0 || separator === trimmed.length - 1) {
        throw new CliUsageError(`invalid --waiver value: ${trimmed}`)
      }

      waivers.push({
        kind: 'waiver',
        ref: trimmed.slice(separator + 1),
        details: {
          waiverKind: trimmed.slice(0, separator),
        },
      })
    }
  }

  return waivers.length > 0 ? waivers : []
}

export async function runTaskTransitionCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--request-handoff'],
    stringFlags: [
      '--task',
      '--to',
      '--actor',
      '--actor-role',
      '--expected-version',
      '--evidence',
      '--idempotency-key',
      '--server',
    ],
    multiStringFlags: ['--waiver'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const actorRole = normalizeRoleName(requireStringFlag(parsed, '--actor-role'), '--actor-role')
  const evidenceRefs =
    readStringFlag(parsed, '--evidence') !== undefined
      ? parseCommaList(requireStringFlag(parsed, '--evidence'), '--evidence')
      : undefined
  const waiverValues = parseWaiverValues(readMultiStringFlag(parsed, '--waiver'))

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.transitionTask({
    actorAgentId,
    actorRole,
    taskId: requireStringFlag(parsed, '--task'),
    toPhase: requireStringFlag(parsed, '--to'),
    expectedVersion: parseIntegerValue(
      '--expected-version',
      requireStringFlag(parsed, '--expected-version'),
      { min: 0 }
    ),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(readStringFlag(parsed, '--idempotency-key') !== undefined
      ? { idempotencyKey: readStringFlag(parsed, '--idempotency-key') }
      : {}),
    ...(hasFlag(parsed, '--request-handoff') ? { requestHandoff: true } : {}),
    ...(waiverValues.length > 0 ? { waivers: waiverValues } : {}),
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(
        renderTransitionApplied({
          taskId: response.task.taskId,
          transition: response.transition,
          version: response.task.version,
          handoff: response.handoff,
          wake: response.wake,
        })
      )
}
