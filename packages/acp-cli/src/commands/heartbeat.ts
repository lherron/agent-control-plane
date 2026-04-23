import { parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'

import {
  createGovernanceClient,
  renderGovernanceResponse,
} from './admin-governance-shared.js'
import type { CommandDependencies, CommandOutput } from './shared.js'

export async function runHeartbeatCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json'],
    stringFlags: ['--agent', '--source', '--note', '--reason', '--server'],
  })

  requireNoPositionals(parsed)
  const client = createGovernanceClient(parsed, deps)

  if (subcommand === 'set') {
    const response = await client.putHeartbeat({
      agentId: requireStringFlag(parsed, '--agent'),
      ...(parsed.stringFlags['--source'] !== undefined
        ? { source: requireStringFlag(parsed, '--source') }
        : {}),
      ...(parsed.stringFlags['--note'] !== undefined
        ? { note: requireStringFlag(parsed, '--note') }
        : {}),
    })
    return renderGovernanceResponse(parsed, response)
  }

  if (subcommand === 'wake') {
    if (parsed.stringFlags['--reason'] !== undefined) {
      requireStringFlag(parsed, '--reason')
    }

    const response = await client.postHeartbeatWake({
      agentId: requireStringFlag(parsed, '--agent'),
    })
    return renderGovernanceResponse(parsed, response)
  }

  throw new CliUsageError(`unknown heartbeat subcommand: ${subcommand}`)
}
