import { parseArgs, parseJsonObject, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'

import { createGovernanceClient, renderGovernanceResponse } from './admin-governance-shared.js'
import type { CommandDependencies } from './shared.js'

export async function runSystemEventCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === 'push') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--kind', '--payload', '--occurred-at', '--server'],
    })
    requireNoPositionals(parsed)
    const response = await createGovernanceClient(parsed, deps).appendSystemEvent({
      projectId: requireStringFlag(parsed, '--project'),
      kind: requireStringFlag(parsed, '--kind'),
      payload: parseJsonObject('--payload', requireStringFlag(parsed, '--payload')),
      occurredAt: requireStringFlag(parsed, '--occurred-at'),
    })
    return renderGovernanceResponse(parsed, response)
  }

  if (subcommand === 'list') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--kind', '--occurred-after', '--occurred-before', '--server'],
    })
    requireNoPositionals(parsed)
    const response = await createGovernanceClient(parsed, deps).listSystemEvents({
      ...(parsed.stringFlags['--project'] !== undefined
        ? { projectId: requireStringFlag(parsed, '--project') }
        : {}),
      ...(parsed.stringFlags['--kind'] !== undefined
        ? { kind: requireStringFlag(parsed, '--kind') }
        : {}),
      ...(parsed.stringFlags['--occurred-after'] !== undefined
        ? { occurredAfter: requireStringFlag(parsed, '--occurred-after') }
        : {}),
      ...(parsed.stringFlags['--occurred-before'] !== undefined
        ? { occurredBefore: requireStringFlag(parsed, '--occurred-before') }
        : {}),
    })
    return renderGovernanceResponse(parsed, response)
  }

  throw new CliUsageError(`unknown system-event subcommand: ${subcommand}`)
}
