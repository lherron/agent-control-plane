import type { ActorRef } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError } from '../http-client.js'
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

export async function runTaskRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--resume'],
    stringFlags: [
      '--task',
      '--role',
      '--agent',
      '--harness',
      '--idempotency-key',
      '--server',
      '--actor',
      '--as',
    ],
    multiStringFlags: [],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const taskId = requireStringFlag(parsed, '--task')
  const role = requireStringFlag(parsed, '--role')

  const asValue = readStringFlag(parsed, '--as')
  const actorValue = readStringFlag(parsed, '--actor')
  const agentValue = readStringFlag(parsed, '--agent')
  const rawAgentId = agentValue ?? asValue ?? actorValue ?? env['ACP_ACTOR_AGENT_ID']
  if (rawAgentId === undefined || rawAgentId.trim().length === 0) {
    throw new CliUsageError('--agent is required (or use --as / --actor / ACP_ACTOR_AGENT_ID)')
  }
  const agentId = normalizeActorId(rawAgentId)

  const harness = readStringFlag(parsed, '--harness')
  const idempotencyKey = readStringFlag(parsed, '--idempotency-key')
  const resume = hasFlag(parsed, '--resume')
  const jsonOutput = hasFlag(parsed, '--json')

  const actor: ActorRef = { kind: 'agent', id: agentId }

  const body: Record<string, unknown> = {
    taskId,
    role,
    actor,
  }

  if (resume) {
    body['resume'] = true
  } else {
    if (harness !== undefined) {
      body['harness'] = { kind: harness }
    }
    if (idempotencyKey !== undefined) {
      body['idempotencyKey'] = idempotencyKey
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-acp-actor-agent-id': agentId,
  }

  const response = await fetchImpl(`${serverUrl}/v1/workflow-participant-runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const responseBody = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    throw new AcpClientHttpError(response.status, responseBody)
  }

  const typedBody = responseBody as {
    participantRun: {
      runId: string
      kind: string
      taskId: string
      role: string
      actor: ActorRef
      status: string
      taskVersionAtStart: number
      contextHash: string
      createdAt: string
    }
    context: { contextHash: string; task: { id: string; version: number } }
  }

  if (jsonOutput) {
    return asJson(typedBody)
  }

  const run = typedBody.participantRun
  const text = `Started participant run ${run.runId} for ${run.taskId} ${run.role}; status=${run.status} context=${run.contextHash}`
  return asText(text)
}
