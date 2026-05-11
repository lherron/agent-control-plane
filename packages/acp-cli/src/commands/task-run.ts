import type { ActorRef } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError } from '../http-client.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  parseJsonObject,
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

function parseHarness(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    return parseJsonObject('--harness', trimmed)
  }
  return { kind: trimmed }
}

function readStringRecordField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readNumberRecordField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export async function runTaskRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--resume', '--launch-runtime'],
    stringFlags: [
      '--task',
      '--role',
      '--agent',
      '--harness',
      '--hrc-run-id',
      '--runtime-id',
      '--launch-id',
      '--host-session-id',
      '--scope-ref',
      '--lane-ref',
      '--generation',
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
  const parsedHarness = parseHarness(harness)
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
    if (parsedHarness !== undefined) {
      body['harness'] = parsedHarness
    }
    if (hasFlag(parsed, '--launch-runtime')) {
      body['launchRuntime'] = true
    }

    const hrcRunId =
      readStringFlag(parsed, '--hrc-run-id') ??
      (parsedHarness !== undefined ? readStringRecordField(parsedHarness, 'hrcRunId') : undefined)
    const runtimeId =
      readStringFlag(parsed, '--runtime-id') ??
      (parsedHarness !== undefined ? readStringRecordField(parsedHarness, 'runtimeId') : undefined)
    const launchId =
      readStringFlag(parsed, '--launch-id') ??
      (parsedHarness !== undefined ? readStringRecordField(parsedHarness, 'launchId') : undefined)
    const hostSessionId =
      readStringFlag(parsed, '--host-session-id') ??
      (parsedHarness !== undefined
        ? readStringRecordField(parsedHarness, 'hostSessionId')
        : undefined)
    const scopeRef =
      readStringFlag(parsed, '--scope-ref') ??
      (parsedHarness !== undefined ? readStringRecordField(parsedHarness, 'scopeRef') : undefined)
    const laneRef =
      readStringFlag(parsed, '--lane-ref') ??
      (parsedHarness !== undefined ? readStringRecordField(parsedHarness, 'laneRef') : undefined)
    const generation =
      readStringFlag(parsed, '--generation') !== undefined
        ? parseIntegerValue('--generation', requireStringFlag(parsed, '--generation'), { min: 0 })
        : parsedHarness !== undefined
          ? readNumberRecordField(parsedHarness, 'generation')
          : undefined

    if (hrcRunId !== undefined) {
      body['hrcRunId'] = hrcRunId
    }
    if (runtimeId !== undefined) {
      body['runtimeId'] = runtimeId
    }
    if (launchId !== undefined) {
      body['launchId'] = launchId
    }
    if (hostSessionId !== undefined) {
      body['hostSessionId'] = hostSessionId
    }
    if (scopeRef !== undefined) {
      body['scopeRef'] = scopeRef
    }
    if (laneRef !== undefined) {
      body['laneRef'] = laneRef
    }
    if (generation !== undefined) {
      body['generation'] = generation
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
