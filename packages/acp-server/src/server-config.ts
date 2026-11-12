import { dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_ASSETS_DIR,
  DEFAULT_INTERFACE_DB_PATH,
  DEFAULT_STATE_DB_PATH,
} from './deps.js'
import { acpStateDir } from './state-dir.js'
const DEFAULT_COORD_DB_PATH = '/Users/lherron/praesidium/var/db/acp-coordination.db'
const DEFAULT_PORT = 18470
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ACTOR = 'acp-server'
const DISALLOWED_BIND_HOSTS = new Set(['0.0.0.0', '::'])

const DEFAULT_ACP_RUNTIME_DIR = '/Users/lherron/praesidium/var/run/acp'
export const DEFAULT_CAP_CATALOG_STATE_DIR = join(acpStateDir(), 'cap-catalog')
export const DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS = 45_000
export const DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS = 45_000
export const DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS = 600_000

export function isEnabledEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

export function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw.length === 0) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export interface AcpServerCliOptions {
  wrkqDbLocator: string
  coordDbPath: string
  interfaceDbPath: string
  stateDbPath: string
  adminDbPath?: string | undefined
  jobsDbPath?: string | undefined
  conversationDbPath?: string | undefined
  agentAssetsDir: string
  host: string
  port: number
  actor: string
}

interface StoppableServer {
  stop(closeActiveConnections?: boolean): void
}

type ParsedCliArgs = {
  help: boolean
  options: Partial<AcpServerCliOptions>
  wrkqDbLocator?: string | undefined
  wrkqDbPath?: string | undefined
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const options: Partial<AcpServerCliOptions> = {}
  let wrkqDbLocator: string | undefined
  let wrkqDbPath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { help: true, options, wrkqDbLocator, wrkqDbPath }
    }

    const nextValue = args[index + 1]
    const requireValue = (flag: string): string => {
      if (nextValue === undefined || nextValue.startsWith('-')) {
        throw new Error(`${flag} requires a value`)
      }

      index += 1
      return nextValue
    }

    switch (arg) {
      case '--wrkq-db':
        wrkqDbLocator = requireValue(arg)
        break
      case '--wrkq-db-path':
        wrkqDbPath = requireValue(arg)
        break
      case '--coord-db-path':
        options.coordDbPath = requireValue(arg)
        break
      case '--host':
        options.host = requireValue(arg)
        break
      case '--admin-db-path':
        options.adminDbPath = requireValue(arg)
        break
      case '--jobs-db-path':
        options.jobsDbPath = requireValue(arg)
        break
      case '--conversation-db-path':
        options.conversationDbPath = requireValue(arg)
        break
      case '--interface-db-path':
        options.interfaceDbPath = requireValue(arg)
        break
      case '--state-db-path':
        options.stateDbPath = requireValue(arg)
        break
      case '--agent-assets-dir':
        options.agentAssetsDir = requireValue(arg)
        break
      case '--port': {
        const port = Number.parseInt(requireValue(arg), 10)
        if (!Number.isFinite(port) || port <= 0) {
          throw new Error('--port must be a positive integer')
        }
        options.port = port
        break
      }
      case '--actor':
        options.actor = requireValue(arg)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return { help: false, options, wrkqDbLocator, wrkqDbPath }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function assertLocalPathInput(name: string, value: string | undefined): void {
  if (nonBlank(value)?.startsWith('rpc://')) {
    throw new Error(`${name} is path-only and must not use an rpc:// locator`)
  }
}

export function resolveCliOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): { help: boolean; options: AcpServerCliOptions } {
  const parsed = parseCliArgs(args)
  const cliLocator = nonBlank(parsed.wrkqDbLocator)
  const cliPath = nonBlank(parsed.wrkqDbPath)
  const acpLocator = nonBlank(env['ACP_WRKQ_DB'])
  const wrkqLocator = nonBlank(env['WRKQ_DB'])
  const acpPath = nonBlank(env['ACP_WRKQ_DB_PATH'])
  const wrkqPath = nonBlank(env['WRKQ_DB_PATH'])

  assertLocalPathInput('--wrkq-db-path', parsed.wrkqDbPath)
  assertLocalPathInput('ACP_WRKQ_DB_PATH', env['ACP_WRKQ_DB_PATH'])
  assertLocalPathInput('WRKQ_DB_PATH', env['WRKQ_DB_PATH'])

  if (cliLocator !== undefined && cliPath !== undefined && cliLocator !== cliPath) {
    throw new Error('--wrkq-db and --wrkq-db-path conflict; supply one value or equal local paths')
  }

  const wrkqDbLocator = cliLocator ?? cliPath ?? acpLocator ?? wrkqLocator ?? acpPath ?? wrkqPath
  if (!parsed.help && wrkqDbLocator === undefined) {
    throw new Error('wrkq database locator is required')
  }

  const envPort = Number.parseInt(env['ACP_PORT'] ?? '', 10)
  const interfaceDbPath =
    parsed.options.interfaceDbPath ?? env['ACP_INTERFACE_DB_PATH'] ?? DEFAULT_INTERFACE_DB_PATH
  const adminDbPath = resolveOptionalSiblingDbPath(
    parsed.options.adminDbPath ?? env['ACP_ADMIN_DB_PATH'],
    interfaceDbPath,
    'acp-admin.db'
  )
  const jobsDbPath = resolveOptionalSiblingDbPath(
    parsed.options.jobsDbPath ?? env['ACP_JOBS_DB_PATH'],
    interfaceDbPath,
    'acp-jobs.db'
  )
  const conversationDbPath = resolveOptionalSiblingDbPath(
    parsed.options.conversationDbPath ?? env['ACP_CONVERSATION_DB_PATH'],
    interfaceDbPath,
    'acp-conversation.db'
  )

  const agentAssetsDir =
    parsed.options.agentAssetsDir ?? env['ACP_AGENT_ASSETS_DIR'] ?? DEFAULT_AGENT_ASSETS_DIR
  const host = normalizeBindHostValue(parsed.options.host ?? env['ACP_HOST'] ?? DEFAULT_HOST)

  return {
    help: parsed.help,
    options: {
      wrkqDbLocator: wrkqDbLocator ?? '',
      coordDbPath: parsed.options.coordDbPath ?? env['ACP_COORD_DB_PATH'] ?? DEFAULT_COORD_DB_PATH,
      interfaceDbPath,
      stateDbPath: parsed.options.stateDbPath ?? env['ACP_STATE_DB_PATH'] ?? DEFAULT_STATE_DB_PATH,
      ...(adminDbPath !== undefined ? { adminDbPath } : {}),
      ...(jobsDbPath !== undefined ? { jobsDbPath } : {}),
      ...(conversationDbPath !== undefined ? { conversationDbPath } : {}),
      agentAssetsDir,
      host,
      port: parsed.options.port ?? (Number.isFinite(envPort) ? envPort : DEFAULT_PORT),
      actor: parsed.options.actor ?? env['ACP_ACTOR'] ?? env['WRKQ_ACTOR'] ?? DEFAULT_ACTOR,
    },
  }
}

export function resolveBindHosts(hostValue: string): string[] {
  const hosts = hostValue.split(',').map((host) => host.trim())
  if (hosts.length === 0 || hosts.some((host) => host.length === 0)) {
    throw new Error('ACP_HOST/--host must contain one or more non-empty hosts')
  }

  for (const host of hosts) {
    if (DISALLOWED_BIND_HOSTS.has(host)) {
      throw new Error(`ACP_HOST/--host must not bind ${host}; list specific hosts instead`)
    }
  }

  return hosts
}

export function bindAcpHostListeners<TServer extends StoppableServer>(
  hosts: readonly string[],
  bind: (host: string) => TServer,
  port: number
): TServer[] {
  const servers: TServer[] = []

  for (const host of hosts) {
    try {
      servers.push(bind(host))
    } catch (error) {
      for (const server of servers) {
        server.stop(true)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`failed to bind ACP server listener on ${host}:${port}: ${message}`)
    }
  }

  return servers
}

function normalizeBindHostValue(hostValue: string): string {
  return resolveBindHosts(hostValue).join(',')
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function formatBindUrls(options: AcpServerCliOptions): string[] {
  return resolveBindHosts(options.host).map(
    (host) => `http://${formatHostForUrl(host)}:${options.port}`
  )
}

/** Startup configuration as `server.listening` log data. */
export function formatStartupConfig(options: AcpServerCliOptions): Record<string, unknown> {
  return {
    endpoints: formatBindUrls(options),
    wrkqLocator: options.wrkqDbLocator,
    coordDb: options.coordDbPath,
    interfaceDb: options.interfaceDbPath,
    stateDb: options.stateDbPath,
    ...(options.adminDbPath !== undefined ? { adminDb: options.adminDbPath } : {}),
    ...(options.jobsDbPath !== undefined ? { jobsDb: options.jobsDbPath } : {}),
    ...(options.conversationDbPath !== undefined
      ? { conversationDb: options.conversationDbPath }
      : {}),
    agentAssets: options.agentAssetsDir,
  }
}

export function renderHelp(): string {
  return [
    'acp-server — Bun.serve wrapper around packages/acp-server',
    '',
    'Usage:',
    '  acp-server [--wrkq-db <locator>] [--wrkq-db-path <path>] [--coord-db-path <path>] [--interface-db-path <path>] [--state-db-path <path>] [--admin-db-path <path>] [--jobs-db-path <path>] [--conversation-db-path <path>] [--agent-assets-dir <path>] [--host <host>] [--port <port>] [--actor <agentId>]',
    '',
    'Environment:',
    '  ACP_WRKQ_DB       Canonical local path or rpc:// locator; defaults to WRKQ_DB',
    '  WRKQ_DB           Canonical local path or rpc:// locator',
    '  ACP_WRKQ_DB_PATH  Legacy path-only input; defaults to WRKQ_DB_PATH',
    '  WRKQ_DB_PATH      Legacy path-only input',
    `  ACP_COORD_DB_PATH Defaults to ${DEFAULT_COORD_DB_PATH}`,
    `  ACP_INTERFACE_DB_PATH Defaults to ${DEFAULT_INTERFACE_DB_PATH}`,
    `  ACP_STATE_DB_PATH Defaults to ${DEFAULT_STATE_DB_PATH}`,
    '  ACP_ADMIN_DB_PATH Opens optional admin store when set; blank uses sibling acp-admin.db',
    '  ACP_JOBS_DB_PATH Opens optional jobs store when set; blank uses sibling acp-jobs.db',
    '  ACP_SCHEDULER_ENABLED Set to 1 or true to enable the in-process jobs scheduler',
    '  ACP_CONVERSATION_DB_PATH Opens optional conversation store when set; blank uses sibling acp-conversation.db',
    `  ACP_AGENT_ASSETS_DIR Defaults to ${DEFAULT_AGENT_ASSETS_DIR}`,
    `  ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS Defaults to ${DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS}`,
    `  ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS Defaults to ${DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS}`,
    `  ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS Defaults to ${DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS}`,
    `  ACP_HOST          Comma-separated bind host list; defaults to ${DEFAULT_HOST}`,
    `  ACP_PORT          Defaults to ${DEFAULT_PORT}`,
    '  ACP_BASE_URL      Set at startup to the server base URL used by capability bindings',
    '  ACP_CAP_SOCKET_PATH Defaults to $ACP_RUNTIME_DIR/cap.sock',
    '  ACP_CAPABILITIES_DIR Defaults to <cwd>/capabilities',
    `  ACP_CAP_CATALOG_STATE_DIR Defaults to ${DEFAULT_CAP_CATALOG_STATE_DIR}`,
    `  ACP_ACTOR         Defaults to WRKQ_ACTOR or ${DEFAULT_ACTOR}`,
    '  WRKF_BIN          Defaults to wrkf',
    '  ACP_WRKF_DISABLED Set to 1 or true to bypass wrkf startup in local dev/test',
    '  ACP_C2_VESTA_SEAT  Vesta seat whose C2 scope row and asks this instance serves; defaults to agent:vesta:project:c2:task:primary',
  ].join('\n')
}

export function resolveAcpBaseUrl(options: AcpServerCliOptions): string {
  const [host = DEFAULT_HOST] = resolveBindHosts(options.host)
  return `http://${formatHostForUrl(host)}:${options.port}`
}

/**
 * The base URL a seat on ANOTHER node uses to reach this server: the first
 * non-loopback bind (the tailnet address in production), else the first bind.
 */
export function resolveAttachmentBaseUrl(
  options: Pick<AcpServerCliOptions, 'host' | 'port'>
): string {
  const hosts = resolveBindHosts(options.host)
  const host = hosts.find((candidate) => !isLoopbackBindHost(candidate)) ?? hosts[0] ?? DEFAULT_HOST
  return `http://${formatHostForUrl(host)}:${options.port}`
}

function isLoopbackBindHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare)
}

export function resolveCapSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['ACP_CAP_SOCKET_PATH']?.trim()
  if (configured !== undefined && configured.length > 0) {
    return configured
  }

  const runtimeDir = env['ACP_RUNTIME_DIR']?.trim() || DEFAULT_ACP_RUNTIME_DIR
  return join(runtimeDir, 'cap.sock')
}

function resolveOptionalSiblingDbPath(
  configuredPath: string | undefined,
  siblingOfPath: string,
  fileName: string
): string | undefined {
  if (configuredPath === undefined) {
    return undefined
  }

  const trimmed = configuredPath.trim()
  if (trimmed.length > 0) {
    return trimmed
  }

  return join(dirname(siblingOfPath), fileName)
}
