import { CliUsageError, type CommandOutput } from '../cli-runtime.js'
import { parseArgs, requireNoPositionals, requireStringFlag } from './options.js'

import { createGovernanceClient, renderGovernanceResponse } from './admin-governance-shared.js'
import type { CommandDependencies } from './shared.js'

export async function runInterfaceIdentityCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand !== 'register') {
    throw new CliUsageError(`unknown interface identity subcommand: ${subcommand}`)
  }

  const parsed = parseArgs(rest, {
    booleanFlags: ['--json'],
    stringFlags: ['--gateway', '--external-id', '--display-name', '--linked-agent', '--server'],
  })
  requireNoPositionals(parsed)
  const response = await createGovernanceClient(parsed, deps).registerInterfaceIdentity({
    gatewayId: requireStringFlag(parsed, '--gateway'),
    externalId: requireStringFlag(parsed, '--external-id'),
    ...(parsed.stringFlags['--display-name'] !== undefined
      ? { displayName: requireStringFlag(parsed, '--display-name') }
      : {}),
    ...(parsed.stringFlags['--linked-agent'] !== undefined
      ? { linkedAgentId: requireStringFlag(parsed, '--linked-agent') }
      : {}),
  })
  return renderGovernanceResponse(parsed, response)
}
