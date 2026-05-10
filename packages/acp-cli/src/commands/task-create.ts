import type { ActorRef } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { renderCreatedWorkflowTask } from '../output/task-render.js'
import { parseRoleAssignment } from '../roles.js'
import {
  hasFlag,
  parseArgs,
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

function parseRoleBindings(values: string[]): Record<string, ActorRef | null> {
  const bindings: Record<string, ActorRef | null> = {}
  for (const value of values) {
    const assignment = parseRoleAssignment(value)
    if (bindings[assignment.role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${assignment.role}`)
    }
    bindings[assignment.role] = { kind: 'agent', id: assignment.agentId }
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
      '--goal',
      '--idempotency-key',
      '--meta',
      '--server',
    ],
    multiStringFlags: ['--role'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.createTask({
    actorAgentId,
    projectId: requireStringFlag(parsed, '--project'),
    workflow: parseWorkflowRef(requireStringFlag(parsed, '--workflow')),
    goal: requireStringFlag(parsed, '--goal'),
    ...(readStringFlag(parsed, '--risk') !== undefined
      ? { risk: readStringFlag(parsed, '--risk') }
      : {}),
    roleBindings: parseRoleBindings(readMultiStringFlag(parsed, '--role')),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(maybeParseMetaFlag(parsed) !== undefined ? { meta: maybeParseMetaFlag(parsed) } : {}),
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(renderCreatedWorkflowTask(response.task))
}
