import { parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'

import {
  createGovernanceClient,
  renderGovernanceResponse,
  resolveGovernanceActorAgentId,
} from './admin-governance-shared.js'
import type { CommandDependencies } from './shared.js'

function parseStatus(value: string): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') {
    throw new CliUsageError('--status must be active or disabled')
  }

  return value
}

export async function runAgentCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === 'create') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--agent', '--display-name', '--status', '--actor', '--server'],
    })
    requireNoPositionals(parsed)
    const client = createGovernanceClient(parsed, deps, { requireActor: true })
    const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, { requireActor: true })
    const response = await client.createAgent({
      actorAgentId: actorAgentId as string,
      agentId: requireStringFlag(parsed, '--agent'),
      ...(parsed.stringFlags['--display-name'] !== undefined
        ? { displayName: requireStringFlag(parsed, '--display-name') }
        : {}),
      status: parseStatus(requireStringFlag(parsed, '--status')),
    })
    return renderGovernanceResponse(parsed, response)
  }

  if (subcommand === 'list') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--server'],
    })
    requireNoPositionals(parsed)
    return renderGovernanceResponse(parsed, await createGovernanceClient(parsed, deps).listAgents())
  }

  if (subcommand === 'show') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--agent', '--server'],
    })
    requireNoPositionals(parsed)
    return renderGovernanceResponse(
      parsed,
      await createGovernanceClient(parsed, deps).getAgent({
        agentId: requireStringFlag(parsed, '--agent'),
      })
    )
  }

  if (subcommand === 'patch') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--agent', '--display-name', '--status', '--actor', '--server'],
    })
    requireNoPositionals(parsed)
    if (
      parsed.stringFlags['--display-name'] === undefined &&
      parsed.stringFlags['--status'] === undefined
    ) {
      throw new CliUsageError('agent patch requires --display-name and/or --status')
    }

    const client = createGovernanceClient(parsed, deps, { requireActor: true })
    const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, { requireActor: true })
    const response = await client.patchAgent({
      actorAgentId: actorAgentId as string,
      agentId: requireStringFlag(parsed, '--agent'),
      ...(parsed.stringFlags['--display-name'] !== undefined
        ? { displayName: requireStringFlag(parsed, '--display-name') }
        : {}),
      ...(parsed.stringFlags['--status'] !== undefined
        ? { status: parseStatus(requireStringFlag(parsed, '--status')) }
        : {}),
    })
    return renderGovernanceResponse(parsed, response)
  }

  throw new CliUsageError(`unknown agent subcommand: ${subcommand}`)
}
