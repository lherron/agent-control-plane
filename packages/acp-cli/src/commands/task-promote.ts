import type { RiskClass } from 'acp-core'

import { CliUsageError } from '../cli-runtime.js'
import { renderPromotedTask } from '../output/task-render.js'
import { normalizeRoleName, parseRoleAssignment } from '../roles.js'
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
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

const ALLOWED_RISK_CLASSES = new Set<RiskClass>(['low', 'medium', 'high'])

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
    throw new CliUsageError('promote requires --role implementer:<agentId>')
  }

  return roleMap
}

export async function runTaskPromoteCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--preset',
      '--preset-version',
      '--risk-class',
      '--actor',
      '--actor-role',
      '--initial-phase',
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

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const initialPhase = readStringFlag(parsed, '--initial-phase')
  const response = await client.promoteTask({
    actorAgentId,
    taskId: requireStringFlag(parsed, '--task'),
    workflowPreset,
    presetVersion,
    riskClass,
    roleMap: parseRoleMap(readMultiStringFlag(parsed, '--role')),
    actorRole: normalizeRoleName(
      readStringFlag(parsed, '--actor-role') ?? 'triager',
      '--actor-role'
    ),
    ...(initialPhase !== undefined ? { initialPhase: initialPhase.trim() } : {}),
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderPromotedTask(response.task))
}
