import {
  hasFlag,
  parseArgs,
  readMultiStringFlag,
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

export async function runTaskObligationWaiveCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--task', '--obligation', '--reason', '--idempotency-key', '--actor', '--server'],
    multiStringFlags: ['--evidence-ref'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')
  const obligationId = requireStringFlag(parsed, '--obligation')
  const response = await getClientFactory(deps)({ serverUrl, actorAgentId }).waiveObligation({
    actorAgentId,
    taskId,
    obligationId,
    reason: requireStringFlag(parsed, '--reason'),
    ...(readMultiStringFlag(parsed, '--evidence-ref').length > 0
      ? { evidenceRefs: readMultiStringFlag(parsed, '--evidence-ref') }
      : {}),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  return asText(`Waived obligation ${response.obligation.obligationId}`)
}
