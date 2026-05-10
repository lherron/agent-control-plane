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
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

function resolveActorFromAs(
  parsed: { stringFlags: Readonly<Record<string, string>> },
  env: NodeJS.ProcessEnv
): string | undefined {
  const asValue = readStringFlag(parsed as never, '--as')
  const actorValue = readStringFlag(parsed as never, '--actor')

  const raw = asValue ?? actorValue ?? env['ACP_ACTOR_AGENT_ID']
  if (raw === undefined || raw.trim().length === 0) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('agent:')) {
    return trimmed.slice('agent:'.length)
  }
  return trimmed
}

export async function runTaskRunCompleteCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--run',
      '--outcome',
      '--summary',
      '--idempotency-key',
      '--actor',
      '--as',
      '--server',
    ],
    multiStringFlags: ['--evidence-ref'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const runId = requireStringFlag(parsed, '--run')
  const outcome = requireStringFlag(parsed, '--outcome')
  const summary = readStringFlag(parsed, '--summary')
  const idempotencyKey = readStringFlag(parsed, '--idempotency-key')
  const evidenceRefs = readMultiStringFlag(parsed, '--evidence-ref')
  const actorAgentId = resolveActorFromAs(parsed, env)

  const body: Record<string, unknown> = {
    outcome,
  }
  if (evidenceRefs.length > 0) {
    body['evidenceRefs'] = evidenceRefs
  }
  if (summary !== undefined) {
    body['summary'] = summary
  }
  if (idempotencyKey !== undefined) {
    body['idempotencyKey'] = idempotencyKey
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (actorAgentId !== undefined) {
    headers['x-acp-actor-agent-id'] = actorAgentId
  }

  const response = await fetchImpl(
    `${serverUrl}/v1/workflow-participant-runs/${encodeURIComponent(runId)}/complete`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  )

  const responseBody = (await response.json()) as Record<string, unknown>

  if (hasFlag(parsed, '--json')) {
    return asJson(responseBody)
  }

  const run = responseBody['participantRun'] as { runId?: string; status?: string } | undefined
  return asText(`Completed participant run ${run?.runId ?? runId}; status=${run?.status ?? 'unknown'}`)
}
