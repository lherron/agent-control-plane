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
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

export async function runTaskObligationCancelCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--task', '--obligation', '--reason', '--idempotency-key', '--actor', '--server'],
    multiStringFlags: [],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')
  const obligationId = requireStringFlag(parsed, '--obligation')
  const response = await getClientFactory(deps)({ serverUrl, actorAgentId }).cancelObligation({
    actorAgentId,
    taskId,
    obligationId,
    reason: requireStringFlag(parsed, '--reason'),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  return asText(`Cancelled obligation ${response.obligation.obligationId}`)
}
