import { type ParsedArgs, hasFlag, parseJsonObject, readStringFlag } from '../cli-args.js'
import { CliUsageError, type CommandOutput } from '../cli-runtime.js'
import {
  type AcpClient,
  AcpClientHttpError,
  AcpClientTransportError,
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

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

function parseResponseText(text: string): unknown {
  if (text.length === 0) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function createRawAcpRequester(options: {
  serverUrl: string
  actorAgentId?: string | undefined
  fetchImpl?: FetchLike | undefined
}): RawAcpRequester {
  const baseUrl = trimTrailingSlashes(options.serverUrl)
  const fetchImpl = options.fetchImpl ?? fetch

  async function doFetch(input: RawAcpRequestInput): Promise<Response> {
    const headers = new Headers(input.headers)
    if (input.body !== undefined) {
      headers.set('content-type', 'application/json')
    }

    const actorAgentId = input.actorAgentId ?? options.actorAgentId
    if (actorAgentId !== undefined) {
      headers.set('x-acp-actor-agent-id', actorAgentId)
    }

    try {
      return await fetchImpl(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      })
    } catch (error) {
      throw new AcpClientTransportError(`failed to reach ACP server at ${baseUrl}`, {
        cause: error,
      })
    }
  }

  return {
    async requestJson<T>(input: RawAcpRequestInput) {
      const response = await doFetch(input)
      const text = await response.text()
      const body = parseResponseText(text)
      if (!response.ok) {
        throw new AcpClientHttpError(response.status, body)
      }
      return body as T
    },

    async requestText(input: RawAcpRequestInput) {
      const response = await doFetch(input)
      const text = await response.text()
      if (!response.ok) {
        throw new AcpClientHttpError(response.status, parseResponseText(text))
      }
      return text
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
