import { CliUsageError, type CommandOutput } from '../cli-runtime.js'
import {
  type AcpClient,
  DEFAULT_ACP_SERVER_URL,
  type FetchLike,
  createHttpClient,
  requestAcpJson,
  requestAcpText,
  trimTrailingSlashes,
} from '../http-client.js'
import { type ParsedArgs, hasFlag, parseJsonObject, readStringFlag } from './options.js'

export type AttachDescriptor = {
  transport: string
  argv: string[]
  bindingFence?: unknown
}

export type CommandDependencies = {
  env?: NodeJS.ProcessEnv | undefined
  createClient?:
    | ((options: {
        serverUrl: string
        actorAgentId?: string | undefined
      }) => AcpClient)
    | undefined
  fetchImpl?: FetchLike | undefined
  attach?: ((descriptor: AttachDescriptor) => Promise<number>) | undefined
}

export type { CommandOutput }

export type RawAcpRequestInput = {
  method: string
  path: string
  body?: unknown
  actorAgentId?: string | undefined
  headers?: Readonly<Record<string, string>> | undefined
}

export type RawAcpRequester = {
  requestJson<T>(input: RawAcpRequestInput): Promise<T>
  requestText(input: RawAcpRequestInput): Promise<string>
}

export function resolveEnv(deps: CommandDependencies): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

export function correlationHeadersFromEnv(
  env: NodeJS.ProcessEnv,
  options: { includeHrcRunId: boolean }
): Record<string, string> {
  const headers: Record<string, string> = {}
  const add = (header: string, value: string | undefined): void => {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed.length > 0) {
      headers[header] = trimmed
    }
  }

  if (options.includeHrcRunId) {
    add('HRC_RUN_ID', env['HRC_RUN_ID'])
  }
  add('HRC_HOST_SESSION_ID', env['HRC_HOST_SESSION_ID'])
  add('HRC_GENERATION', env['HRC_GENERATION'])
  return headers
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

export function createRawAcpRequester(options: {
  serverUrl: string
  actorAgentId?: string | undefined
  fetchImpl?: FetchLike | undefined
}): RawAcpRequester {
  const baseUrl = trimTrailingSlashes(options.serverUrl)
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async requestJson<T>(input: RawAcpRequestInput) {
      return requestAcpJson<T>(input, {
        baseUrl,
        ...(options.actorAgentId !== undefined ? { actorAgentId: options.actorAgentId } : {}),
        fetchImpl,
      })
    },

    async requestText(input: RawAcpRequestInput) {
      return requestAcpText(input, {
        baseUrl,
        ...(options.actorAgentId !== undefined ? { actorAgentId: options.actorAgentId } : {}),
        fetchImpl,
      })
    },
  }
}

export function createRawRequesterFromParsed(
  parsed: ParsedArgs,
  deps: CommandDependencies,
  options: { requireActor?: boolean | undefined } = {}
): RawAcpRequester {
  const env = resolveEnv(deps)
  const actorAgentId = options.requireActor
    ? requireActorAgentId(readStringFlag(parsed, '--actor'), env)
    : resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)

  return createRawAcpRequester({
    serverUrl: resolveServerUrl(readStringFlag(parsed, '--server'), env),
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
    fetchImpl: deps.fetchImpl,
  })
}

export function renderJsonOrTable(
  parsed: ParsedArgs,
  body: unknown,
  renderTableText: () => string
): CommandOutput {
  if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
    return asText(renderTableText())
  }

  return asJson(body)
}

export function asJson(body: unknown): CommandOutput {
  return { format: 'json', body }
}

export function asText(text: string): CommandOutput {
  return { format: 'text', text }
}
