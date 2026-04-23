import { parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'

import {
  createGovernanceClient,
  renderGovernanceResponse,
  resolveGovernanceActorAgentId,
} from './admin-governance-shared.js'
import type { CommandDependencies } from './shared.js'

function parseRole(value: string): 'coordinator' | 'implementer' | 'tester' | 'observer' {
  if (
    value !== 'coordinator' &&
    value !== 'implementer' &&
    value !== 'tester' &&
    value !== 'observer'
  ) {
    throw new CliUsageError('--role must be coordinator, implementer, tester, or observer')
  }

  return value
}

export async function runMembershipCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === 'add') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--agent', '--role', '--actor', '--server'],
    })
    requireNoPositionals(parsed)
    const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, { requireActor: true })
    const response = await createGovernanceClient(parsed, deps, {
      requireActor: true,
    }).addMembership({
      actorAgentId: actorAgentId as string,
      projectId: requireStringFlag(parsed, '--project'),
      agentId: requireStringFlag(parsed, '--agent'),
      role: parseRole(requireStringFlag(parsed, '--role')),
    })
    return renderGovernanceResponse(parsed, response)
  }

  if (subcommand === 'list') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--server'],
    })
    requireNoPositionals(parsed)
    return renderGovernanceResponse(
      parsed,
      await createGovernanceClient(parsed, deps).listMemberships({
        projectId: requireStringFlag(parsed, '--project'),
      })
    )
  }

  throw new CliUsageError(`unknown membership subcommand: ${subcommand}`)
}
