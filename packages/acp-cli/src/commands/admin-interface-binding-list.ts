import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { renderInterfaceBindings } from '../output/interface-binding-render.js'

import { createAdminClient } from './admin-interface-binding-shared.js'
import { type CommandDependencies, type CommandOutput, asJson, asText } from './shared.js'

export async function runAdminInterfaceBindingListCommand(
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
      '--server',
      '--actor',
    ],
  })
  requireNoPositionals(parsed)

  const client = createAdminClient(parsed, deps)
  const response = await client.listInterfaceBindings({
    ...(parsed.stringFlags['--gateway'] !== undefined
      ? { gatewayId: requireStringFlag(parsed, '--gateway') }
      : {}),
    ...(parsed.stringFlags['--conversation-ref'] !== undefined
      ? { conversationRef: requireStringFlag(parsed, '--conversation-ref') }
      : {}),
    ...(parsed.stringFlags['--thread-ref'] !== undefined
      ? { threadRef: requireStringFlag(parsed, '--thread-ref') }
      : {}),
    ...(parsed.stringFlags['--project'] !== undefined
      ? { projectId: requireStringFlag(parsed, '--project') }
      : {}),
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(renderInterfaceBindings(response.bindings))
}
