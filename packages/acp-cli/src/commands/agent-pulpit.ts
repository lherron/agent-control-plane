import { randomUUID } from 'node:crypto'

import { CliUsageError } from '../cli-runtime.js'
import {
  hasFlag,
  parseArgs,
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
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

function generatedIdempotencyKey(): string {
  return `acp-cli:agent-pulpit:${randomUUID()}`
}

export async function runAgentPulpitCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const [subcommand, ...rest] = args
  if (subcommand !== 'send') {
    throw new CliUsageError(
      'usage: acp agent-pulpit send --text <text> [--binding <id> | --gateway-type <type> --agent <agentId> --project <projectId>]'
    )
  }

  const parsed = parseArgs(rest, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--binding',
      '--gateway-type',
      '--agent',
      '--project',
      '--lane-ref',
      '--text',
      '--idempotency-key',
      '--server',
      '--actor',
    ],
  })
  requireNoPositionals(parsed)

  const bindingId = readStringFlag(parsed, '--binding')?.trim()
  const gatewayType = readStringFlag(parsed, '--gateway-type')?.trim()
  const agentId = readStringFlag(parsed, '--agent')?.trim()
  const projectId = readStringFlag(parsed, '--project')?.trim()
  if (
    bindingId !== undefined &&
    (gatewayType !== undefined || agentId !== undefined || projectId !== undefined)
  ) {
    throw new CliUsageError(
      'provide either --binding or --gateway-type/--agent/--project selectors, not both'
    )
  }
  if (
    bindingId === undefined &&
    (gatewayType === undefined || agentId === undefined || projectId === undefined)
  ) {
    throw new CliUsageError(
      '--gateway-type, --agent, and --project are required when --binding is omitted'
    )
  }

  const env = resolveEnv(deps)
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const client = getClientFactory(deps)({
    serverUrl,
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
  })
  const idempotencyKey =
    readStringFlag(parsed, '--idempotency-key')?.trim() || generatedIdempotencyKey()

  const response = await client.createAgentPulpitMessage({
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
    ...(gatewayType !== undefined ? { gatewayType } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(readStringFlag(parsed, '--lane-ref') !== undefined
      ? { laneRef: requireStringFlag(parsed, '--lane-ref') }
      : {}),
    text: requireStringFlag(parsed, '--text'),
    idempotencyKey,
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(
        [
          `Queued ${response.delivery.deliveryRequestId} (${response.delivery.status})`,
          `idempotencyKey: ${response.idempotencyKey}`,
        ].join('\n')
      )
}
