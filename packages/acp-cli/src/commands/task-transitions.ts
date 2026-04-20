import {
  hasFlag,
  parseArgs,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { renderTransitions } from '../output/transitions-render.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  getClientFactory,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

export async function runTaskTransitionsCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--task', '--server'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const client = getClientFactory(deps)({ serverUrl })
  const response = await client.listTransitions({
    taskId: requireStringFlag(parsed, '--task'),
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(renderTransitions(response.transitions))
}
