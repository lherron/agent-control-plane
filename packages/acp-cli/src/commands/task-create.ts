import type { RiskClass } from 'acp-core'

import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  readMultiStringFlag,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderCreatedTask } from '../output/task-render.js'
import { parseRoleAssignment } from '../roles.js'
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

const ALLOWED_RISK_CLASSES = new Set<RiskClass>(['low', 'medium', 'high'])
const ALLOWED_KINDS = new Set(['task', 'bug', 'spike', 'chore'])

function parseRoleMap(values: string[]): Record<string, string> {
  const roleMap: Record<string, string> = {}
  for (const value of values) {
    const assignment = parseRoleAssignment(value)
    if (roleMap[assignment.role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${assignment.role}`)
    }
    roleMap[assignment.role] = assignment.agentId
  }

  if (roleMap['implementer'] === undefined) {
    throw new CliUsageError('create requires --role implementer:<agentId>')
  }

  return roleMap
}

export async function runTaskCreateCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--preset',
      '--preset-version',
      '--risk-class',
      '--project',
      '--actor',
      '--kind',
      '--meta',
      '--server',
    ],
    multiStringFlags: ['--role'],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const workflowPreset = requireStringFlag(parsed, '--preset')
  const presetVersion = parseIntegerValue(
    '--preset-version',
    requireStringFlag(parsed, '--preset-version'),
    { min: 1 }
  )
  const riskClass = requireStringFlag(parsed, '--risk-class') as RiskClass
  if (!ALLOWED_RISK_CLASSES.has(riskClass)) {
    throw new CliUsageError('--risk-class must be one of: low, medium, high')
  }

  const kind = readStringFlag(parsed, '--kind') ?? 'task'
  if (!ALLOWED_KINDS.has(kind)) {
    throw new CliUsageError('--kind must be one of: task, bug, spike, chore')
  }

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.createTask({
    actorAgentId,
    projectId: requireStringFlag(parsed, '--project'),
    workflowPreset,
    presetVersion,
    riskClass,
    kind,
    roleMap: parseRoleMap(readMultiStringFlag(parsed, '--role')),
    ...(maybeParseMetaFlag(parsed) !== undefined ? { meta: maybeParseMetaFlag(parsed) } : {}),
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderCreatedTask(response.task))
}
