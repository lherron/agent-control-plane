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

export async function runTaskEvidenceAddCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--kind',
      '--ref',
      '--role',
      '--run-id',
      '--supervisor-run-id',
      '--participant-run-id',
      '--idempotency-key',
      '--actor',
      '--server',
    ],
    multiStringFlags: [],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')
  const kind = requireStringFlag(parsed, '--kind')
  const ref = requireStringFlag(parsed, '--ref')
  const idempotencyKey = requireStringFlag(parsed, '--idempotency-key')
  const role = readStringFlag(parsed, '--role')
  const runId = readStringFlag(parsed, '--run-id')
  const supervisorRunId = readStringFlag(parsed, '--supervisor-run-id')
  const participantRunId = readStringFlag(parsed, '--participant-run-id')

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.addEvidence({
    actorAgentId,
    taskId,
    ...(role !== undefined ? { role } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(supervisorRunId !== undefined ? { supervisorRunId } : {}),
    ...(participantRunId !== undefined ? { participantRunId } : {}),
    evidence: [{ kind, ref }],
    idempotencyKey,
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(JSON.stringify(response, null, 2))
}
