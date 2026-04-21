import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'

import { createAdminClient, resolveSessionInput } from './admin-interface-binding-shared.js'
import { type CommandDependencies, type CommandOutput, asJson, asText } from './shared.js'

export async function runAdminInterfaceBindingSetCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--gateway',
      '--conversation-ref',
      '--thread-ref',
      '--project',
      '--session',
      '--scope-ref',
      '--lane-ref',
      '--server',
      '--actor',
    ],
  })
  requireNoPositionals(parsed)

  const sessionRef = resolveSessionInput(parsed)
  const client = createAdminClient(parsed, deps)
  const response = await client.upsertInterfaceBinding({
    gatewayId: requireStringFlag(parsed, '--gateway'),
    conversationRef: requireStringFlag(parsed, '--conversation-ref'),
    ...(parsed.stringFlags['--thread-ref'] !== undefined
      ? { threadRef: requireStringFlag(parsed, '--thread-ref') }
      : {}),
    ...(parsed.stringFlags['--project'] !== undefined
      ? { projectId: requireStringFlag(parsed, '--project') }
      : {}),
    sessionRef,
    status: 'active',
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(
        `Bound ${response.binding.gatewayId} ${response.binding.conversationRef} to ${response.binding.sessionRef.scopeRef} (${response.binding.sessionRef.laneRef})`
      )
}
