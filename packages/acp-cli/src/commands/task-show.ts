import { renderTask } from '../output/task-render.js'
import { normalizeRoleName } from '../roles.js'
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

export async function runTaskShowCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--task', '--role', '--server', '--actor'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const role = readStringFlag(parsed, '--role')
  const client = getClientFactory(deps)({
    serverUrl,
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
  })
  const response = await client.getTask({
    taskId: requireStringFlag(parsed, '--task'),
    ...(role !== undefined ? { role: normalizeRoleName(role, '--role') } : {}),
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderTask(response))
}
