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
  createRawAcpRequester,
  getClientFactory,
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

function normalizeActorId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('agent:')) {
    return trimmed.slice('agent:'.length)
  }
  return trimmed
}

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
      '--supervisor-run',
      '--participant-run-id',
      '--idempotency-key',
      '--actor',
      '--as',
      '--server',
      '--summary',
      '--from-run',
    ],
    multiStringFlags: [],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const asValue = readStringFlag(parsed, '--as')
  const actorValue = readStringFlag(parsed, '--actor')
  const rawActor = asValue ?? actorValue
  const actorAgentId = requireActorAgentId(
    rawActor !== undefined ? normalizeActorId(rawActor) : undefined,
    env
  )
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')
  const kind = requireStringFlag(parsed, '--kind')
  const ref = requireStringFlag(parsed, '--ref')
  const idempotencyKey = requireStringFlag(parsed, '--idempotency-key')
  const summary = readStringFlag(parsed, '--summary')
  const fromRun = readStringFlag(parsed, '--from-run')

  let role = readStringFlag(parsed, '--role')
  let runId = readStringFlag(parsed, '--run-id')
  const supervisorRunId =
    readStringFlag(parsed, '--supervisor-run-id') ?? readStringFlag(parsed, '--supervisor-run')
  let participantRunId = readStringFlag(parsed, '--participant-run-id')

  // --from-run: lookup the wrkf run from the task snapshot.
  if (fromRun !== undefined) {
    const requester = createRawAcpRequester({
      serverUrl,
      actorAgentId,
      fetchImpl: deps.fetchImpl,
    })
    const taskSnapshot = await requester.requestJson<{
      runs: Array<{
        id: string
        role: string
      }>
    }>({
      method: 'GET',
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
    })
    const run = taskSnapshot.runs.find((r) => r.id === fromRun)
    if (run !== undefined) {
      role = role ?? run.role
      runId = runId ?? run.id
      participantRunId = participantRunId ?? run.id
    }
  }

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const evidence: Array<{ kind: string; ref: string; summary?: string }> = [
    {
      kind,
      ref,
      ...(summary !== undefined ? { summary } : {}),
    },
  ]

  const response = await client.addEvidence({
    actorAgentId,
    taskId,
    ...(role !== undefined ? { role } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(supervisorRunId !== undefined ? { supervisorRunId } : {}),
    ...(participantRunId !== undefined ? { participantRunId } : {}),
    evidence,
    idempotencyKey,
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(JSON.stringify(response, null, 2))
}
