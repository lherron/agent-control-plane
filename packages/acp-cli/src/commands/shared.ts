import { parseJsonObject, readStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'
import {
  type AcpClient,
  DEFAULT_ACP_SERVER_URL,
  type FetchLike,
  createHttpClient,
} from '../http-client.js'

export type CommandDependencies = {
  env?: NodeJS.ProcessEnv | undefined
  createClient?:
    | ((options: {
        serverUrl: string
        actorAgentId?: string | undefined
      }) => AcpClient)
    | undefined
  fetchImpl?: FetchLike | undefined
}

export type { CommandOutput }

export function resolveEnv(deps: CommandDependencies): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

export function resolveServerUrl(
  parsedFlagValue: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  return parsedFlagValue ?? env['ACP_SERVER_URL'] ?? DEFAULT_ACP_SERVER_URL
}

export function resolveOptionalActorAgentId(
  parsedFlagValue: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  const value = parsedFlagValue ?? env['ACP_ACTOR_AGENT_ID']
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function requireActorAgentId(
  parsedFlagValue: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  const actorAgentId = resolveOptionalActorAgentId(parsedFlagValue, env)
  if (actorAgentId === undefined) {
    throw new CliUsageError('--actor is required (or set ACP_ACTOR_AGENT_ID)')
  }
  return actorAgentId
}

export function maybeParseMetaFlag(
  parsed: { stringFlags: Readonly<Record<string, string>> },
  flag = '--meta'
): Record<string, unknown> | undefined {
  const raw = readStringFlag(parsed as never, flag)
  return raw === undefined ? undefined : parseJsonObject(flag, raw)
}

export function getClientFactory(
  deps: CommandDependencies
): NonNullable<CommandDependencies['createClient']> {
  return (
    deps.createClient ??
    ((options) =>
      createHttpClient({
        serverUrl: options.serverUrl,
        actorAgentId: options.actorAgentId,
        fetchImpl: deps.fetchImpl,
      }))
  )
}

export function asJson(body: unknown): CommandOutput {
  return { format: 'json', body }
}

export function asText(text: string): CommandOutput {
  return { format: 'text', text }
}
