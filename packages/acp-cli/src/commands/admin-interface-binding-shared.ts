import { CliUsageError } from '../cli-runtime.js'
import { normalizeScopeInput } from '../scope-input.js'
import { readStringFlag } from './options.js'

import {
  type CommandDependencies,
  getClientFactory,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

export function createAdminClient(
  parsed: { stringFlags: Readonly<Record<string, string>> },
  deps: CommandDependencies
) {
  const env = resolveEnv(deps)
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed as never, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed as never, '--server'), env)

  return getClientFactory(deps)({
    serverUrl,
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
  })
}

export function resolveSessionInput(parsed: {
  stringFlags: Readonly<Record<string, string>>
}): {
  scopeRef: string
  laneRef?: string | undefined
} {
  const session = readStringFlag(parsed as never, '--session')
  const scopeRef = readStringFlag(parsed as never, '--scope-ref')
  const laneRef = readStringFlag(parsed as never, '--lane-ref')

  if (session !== undefined && scopeRef !== undefined) {
    throw new CliUsageError('provide either --session or --scope-ref, not both')
  }

  if (session === undefined && scopeRef === undefined) {
    throw new CliUsageError('either --session or --scope-ref is required')
  }

  try {
    return normalizeScopeInput(session ?? scopeRef ?? '', laneRef)
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}
