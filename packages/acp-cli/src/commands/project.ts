import { parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'

import {
  createGovernanceClient,
  renderGovernanceResponse,
  resolveGovernanceActorAgentId,
} from './admin-governance-shared.js'
import type { CommandDependencies } from './shared.js'

export async function runProjectCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === 'create') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--display-name', '--root-dir', '--actor', '--server'],
    })
    requireNoPositionals(parsed)
    const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, { requireActor: true })
    const response = await createGovernanceClient(parsed, deps, {
      requireActor: true,
    }).createProject({
      actorAgentId: actorAgentId as string,
      projectId: requireStringFlag(parsed, '--project'),
      displayName: requireStringFlag(parsed, '--display-name'),
      ...(parsed.stringFlags['--root-dir'] !== undefined
        ? { rootDir: requireStringFlag(parsed, '--root-dir') }
        : {}),
    })
    return renderGovernanceResponse(parsed, response)
  }

  if (subcommand === 'list') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--server'],
    })
    requireNoPositionals(parsed)
    return renderGovernanceResponse(
      parsed,
      await createGovernanceClient(parsed, deps).listProjects()
    )
  }

  if (subcommand === 'show') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--server'],
    })
    requireNoPositionals(parsed)
    return renderGovernanceResponse(
      parsed,
      await createGovernanceClient(parsed, deps).getProject({
        projectId: requireStringFlag(parsed, '--project'),
      })
    )
  }

  if (subcommand === 'default-agent') {
    const parsed = parseArgs(rest, {
      booleanFlags: ['--json'],
      stringFlags: ['--project', '--agent', '--actor', '--server'],
    })
    requireNoPositionals(parsed)
    const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, { requireActor: true })
    const response = await createGovernanceClient(parsed, deps, {
      requireActor: true,
    }).setProjectDefaultAgent({
      actorAgentId: actorAgentId as string,
      projectId: requireStringFlag(parsed, '--project'),
      agentId: requireStringFlag(parsed, '--agent'),
    })
    return renderGovernanceResponse(parsed, response)
  }

  throw new CliUsageError(`unknown project subcommand: ${subcommand}`)
}
