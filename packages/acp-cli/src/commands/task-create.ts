import type { ActorRef } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { renderCreatedWorkflowTask } from '../output/task-render.js'
import { parseRoleAssignment } from '../roles.js'
import {
  hasFlag,
  parseArgs,
  parseCommaList,
  parseIntegerValue,
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
  maybeParseMetaFlag,
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

function parseWorkflowRef(value: string): { id: string; version: number } {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) {
    throw new CliUsageError('--workflow must use id@version, for example basic@1')
  }
  return {
    id: value.slice(0, at),
    version: parseIntegerValue('--workflow', value.slice(at + 1), { min: 1 }),
  }
}

function parseBindAssignment(raw: string): { role: string; actor: ActorRef } {
  const separator = raw.indexOf('=')
  if (separator <= 0 || separator === raw.length - 1) {
    throw new CliUsageError(`invalid --bind assignment: ${raw}`)
  }
  const role = raw.slice(0, separator).trim().toLowerCase().replaceAll('-', '_')
  const actorRaw = raw.slice(separator + 1).trim()
  if (actorRaw.length === 0) {
    throw new CliUsageError(`invalid --bind assignment: ${raw}`)
  }
  const colonIndex = actorRaw.indexOf(':')
  if (colonIndex > 0 && colonIndex < actorRaw.length - 1) {
    return {
      role,
      actor: { kind: actorRaw.slice(0, colonIndex) as ActorRef['kind'], id: actorRaw.slice(colonIndex + 1) },
    }
  }
  return { role, actor: { kind: 'agent', id: actorRaw } }
}

function parseRoleBindings(
  roleValues: string[],
  bindValues: string[]
): Record<string, ActorRef | null> {
  const bindings: Record<string, ActorRef | null> = {}
  for (const value of roleValues) {
    const assignment = parseRoleAssignment(value)
    if (bindings[assignment.role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${assignment.role}`)
    }
    bindings[assignment.role] = { kind: 'agent', id: assignment.agentId }
  }
  for (const value of bindValues) {
    const assignment = parseBindAssignment(value)
    if (bindings[assignment.role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${assignment.role}`)
    }
    bindings[assignment.role] = assignment.actor
  }
  return bindings
}

export async function runTaskCreateCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--workflow',
      '--risk',
      '--project',
      '--actor',
      '--as',
      '--goal',
      '--idempotency-key',
      '--meta',
      '--server',
      '--task-id',
      '--supervisor',
      '--supervisor-autonomy',
      '--supervisor-capability',
    ],
    multiStringFlags: ['--role', '--bind'],
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
  const client = getClientFactory(deps)({ serverUrl, actorAgentId })

  const supervisorValue = readStringFlag(parsed, '--supervisor')
  const supervisorAutonomy = readStringFlag(parsed, '--supervisor-autonomy')
  const supervisorCapabilityCsv = readStringFlag(parsed, '--supervisor-capability')

  const response = await client.createTask({
    actorAgentId,
    projectId: requireStringFlag(parsed, '--project'),
    workflow: parseWorkflowRef(requireStringFlag(parsed, '--workflow')),
    goal: requireStringFlag(parsed, '--goal'),
    ...(readStringFlag(parsed, '--risk') !== undefined
      ? { risk: readStringFlag(parsed, '--risk') }
      : {}),
    roleBindings: parseRoleBindings(
      readMultiStringFlag(parsed, '--role'),
      readMultiStringFlag(parsed, '--bind')
    ),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(maybeParseMetaFlag(parsed) !== undefined ? { meta: maybeParseMetaFlag(parsed) } : {}),
    ...(readStringFlag(parsed, '--task-id') !== undefined
      ? { taskId: readStringFlag(parsed, '--task-id') }
      : {}),
    ...(supervisorValue !== undefined
      ? {
          supervisor: {
            actor: { kind: 'agent' as const, id: normalizeActorId(supervisorValue) },
            autonomy: supervisorAutonomy ?? 'managed',
            capabilities:
              supervisorCapabilityCsv !== undefined
                ? Object.fromEntries(
                    parseCommaList(supervisorCapabilityCsv, '--supervisor-capability').map(
                      (cap) => [cap, true]
                    )
                  )
                : {},
          },
        }
      : {}),
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(renderCreatedWorkflowTask(response.task))
}
