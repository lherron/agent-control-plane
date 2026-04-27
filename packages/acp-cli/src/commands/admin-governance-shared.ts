import { type ParsedArgs, hasFlag, readStringFlag } from './options.js'

import { type CommandDependencies, type CommandOutput, asJson, asText } from './shared.js'
import {
  getClientFactory,
  requireActorAgentId,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

export function createGovernanceClient(
  parsed: ParsedArgs,
  deps: CommandDependencies,
  options: { requireActor?: boolean | undefined } = {}
) {
  const env = resolveEnv(deps)
  const actorAgentId = resolveGovernanceActorAgentId(parsed, deps, options)

  return getClientFactory(deps)({
    serverUrl: resolveServerUrl(readStringFlag(parsed, '--server'), env),
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
  })
}

export function resolveGovernanceActorAgentId(
  parsed: ParsedArgs,
  deps: CommandDependencies,
  options: { requireActor?: boolean | undefined } = {}
): string | undefined {
  const env = resolveEnv(deps)
  return options.requireActor
    ? requireActorAgentId(readStringFlag(parsed, '--actor'), env)
    : resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
}

export function renderGovernanceResponse(parsed: ParsedArgs, body: unknown): CommandOutput {
  return hasFlag(parsed, '--json') ? asJson(body) : asText(JSON.stringify(body, null, 2))
}
