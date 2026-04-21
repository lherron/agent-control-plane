import { openSync, readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { type AcpServerCliOptions, resolveCliOptions, startAcpServeBin } from 'acp-server'
import {
  DEFAULT_BINDINGS_REFRESH_MS,
  DEFAULT_DELIVERY_IDLE_MS,
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_MAX_CHARS,
  GatewayDiscordApp,
  envNumber,
} from 'gateway-discord'
import { WrkqSchemaMissingError } from 'wrkq-lib'

import { CliServerError, CliUsageError, printJson, printText } from './cli-runtime.js'

const DEFAULT_RUNTIME_ROOT = '/Users/lherron/praesidium/var/run/acp'
const DEFAULT_LOG_PATH = '/Users/lherron/praesidium/var/logs/acp-server.log'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18470
const DEFAULT_LAUNCHD_LABEL = 'com.praesidium.acp-server'
const DEFAULT_GATEWAY_ID = 'acp-discord-smoke'

export type AcpServerPaths = {
  runtimeRoot: string
  pidPath: string
  logPath: string
}

export type LaunchdOwner = {
  label: string
  domain: string
  serviceTarget: string
}

export type AcpServerRuntimeStatus = {
  running: boolean
  pid?: number | undefined
  pidAlive: boolean
  pidPath: string
  endpoint: string
  endpointResponsive: boolean
}

export function renderServerHelp(): string {
  return [
    'Usage:',
    '  acp server [start] [--foreground|--daemon] [options]',
    '  acp server serve [options]',
    '  acp server stop [--timeout-ms <ms>] [--force]',
    '  acp server restart [--foreground|--daemon] [options]',
    '  acp server status [--json]',
    '  acp server health',
    '',
    'Options:',
    '  --no-discord              Start only the ACP HTTP server',
    '  --wrkq-db-path <path>     Defaults to ACP_WRKQ_DB_PATH or WRKQ_DB_PATH',
    '  --coord-db-path <path>    Defaults to ACP_COORD_DB_PATH',
    '  --interface-db-path <path> Defaults to ACP_INTERFACE_DB_PATH',
    '  --host <host>             Defaults to ACP_HOST or 127.0.0.1',
    '  --port <port>             Defaults to ACP_PORT or 18470',
    '  --actor <agentId>         Defaults to ACP_ACTOR, WRKQ_ACTOR, or acp-server',
    '',
    'Environment:',
    '  ACP_RUNTIME_DIR           Runtime files (default: /Users/lherron/praesidium/var/run/acp)',
    '  ACP_LOG_PATH              Daemon fallback log (default: /Users/lherron/praesidium/var/logs/acp-server.log)',
    '  ACP_REAL_HRC_LAUNCHER     Defaults to 1 for acp server',
    '  ACP_DISABLE_DISCORD_GATEWAY=1 disables the in-process Discord gateway',
    '  DISCORD_TOKEN             Discord bot token; falls back to DISCORD_BLASTER_TOKEN, then Consul',
    '  ACP_DISCORD_TOKEN_KV      Consul KV path for token fallback',
    '  ACP_LAUNCHD_LABEL         LaunchAgent label (default: com.praesidium.acp-server)',
  ].join('\n')
}

function hasFlag(args: readonly string[], ...names: string[]): boolean {
  return args.some((arg) => names.includes(arg))
}

function valueAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  return args[index + 1]
}

function parseTimeoutMs(args: readonly string[], fallback: number): number {
  const raw = valueAfter(args, '--timeout-ms')
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError('--timeout-ms must be a positive integer')
  }
  return parsed
}

function stripLifecycleArgs(args: readonly string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) {
      continue
    }
    if (
      arg === '--foreground' ||
      arg === '--daemon' ||
      arg === '-d' ||
      arg === '--background' ||
      arg === '--no-discord' ||
      arg === '--force' ||
      arg === '--json'
    ) {
      continue
    }
    if (arg === '--timeout-ms') {
      index += 1
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

function resolveServerMode(
  args: readonly string[],
  defaultMode: 'foreground' | 'daemon'
): 'foreground' | 'daemon' {
  const wantsDaemon = hasFlag(args, '--daemon', '-d', '--background')
  const wantsForeground = hasFlag(args, '--foreground')
  if (wantsDaemon && wantsForeground) {
    throw new CliUsageError('choose either --foreground or --daemon/--background, not both')
  }
  if (wantsForeground) {
    return 'foreground'
  }
  if (wantsDaemon) {
    return 'daemon'
  }
  return defaultMode
}

export function resolveAcpServerPaths(env: NodeJS.ProcessEnv = process.env): AcpServerPaths {
  const runtimeRoot = env['ACP_RUNTIME_DIR'] ?? DEFAULT_RUNTIME_ROOT
  return {
    runtimeRoot,
    pidPath: `${runtimeRoot}/server.pid`,
    logPath: env['ACP_LOG_PATH'] ?? DEFAULT_LOG_PATH,
  }
}

function readPidFile(pidPath: string): number | undefined {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim()
    if (raw.length === 0) {
      return undefined
    }
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ESRCH') {
      return false
    }
    if (code === 'EPERM') {
      return true
    }
    throw error
  }
}

async function isTcpResponsive(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    let settled = false

    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await delay(intervalMs)
  }
  return await check()
}

export async function execProcess(argv: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

export async function detectLaunchdOwner(
  env: NodeJS.ProcessEnv = process.env
): Promise<LaunchdOwner | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) {
    return null
  }

  const label = env['ACP_LAUNCHD_LABEL'] ?? DEFAULT_LAUNCHD_LABEL
  const domain = `gui/${uid}`
  const serviceTarget = `${domain}/${label}`
  const result = await execProcess(['launchctl', 'print', serviceTarget])
  if (result.exitCode !== 0) {
    return null
  }
  return { label, domain, serviceTarget }
}

export async function launchctlKickstart(
  owner: LaunchdOwner,
  opts: { kill?: boolean } = {}
): Promise<void> {
  const argv = ['launchctl', 'kickstart']
  if (opts.kill) {
    argv.push('-k')
  }
  argv.push(owner.serviceTarget)
  const result = await execProcess(argv)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new CliServerError(
      `launchctl kickstart failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
    )
  }
}

function resolveStatusEndpoint(args: readonly string[]): { host: string; port: number } {
  const host = valueAfter(args, '--host') ?? process.env['ACP_HOST'] ?? DEFAULT_HOST
  const rawPort = valueAfter(args, '--port') ?? process.env['ACP_PORT']
  const port = rawPort === undefined ? DEFAULT_PORT : Number.parseInt(rawPort, 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new CliUsageError('--port must be a positive integer')
  }
  return { host, port }
}

export async function collectAcpServerStatus(
  args: readonly string[] = []
): Promise<AcpServerRuntimeStatus> {
  const paths = resolveAcpServerPaths()
  const { host, port } = resolveStatusEndpoint(args)
  const pid = readPidFile(paths.pidPath)
  const pidAlive = pid !== undefined ? isLiveProcess(pid) : false
  const endpointResponsive = await isTcpResponsive(host, port)
  return {
    running: endpointResponsive && (pid === undefined || pidAlive),
    ...(pid !== undefined ? { pid } : {}),
    pidAlive,
    pidPath: paths.pidPath,
    endpoint: `http://${host}:${port}`,
    endpointResponsive,
  }
}

export function formatAcpServerStatus(status: AcpServerRuntimeStatus): string {
  return `${[
    'ACP Server Status',
    `  running:     ${status.running ? 'yes' : 'no'}`,
    `  pid:         ${status.pid ?? '(none)'}`,
    `  pid alive:   ${status.pidAlive ? 'yes' : 'no'}`,
    `  pid file:    ${status.pidPath}`,
    `  endpoint:    ${status.endpoint}${status.endpointResponsive ? ' (responsive)' : ' (down)'}`,
  ].join('\n')}\n`
}

function gatewayDisabled(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    hasFlag(args, '--no-discord') ||
    env['ACP_DISABLE_DISCORD_GATEWAY'] === '1' ||
    env['ACP_SERVER_NO_DISCORD'] === '1'
  )
}

function optionalEnvValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.length > 0) {
      return value
    }
  }
  return undefined
}

function resolveGatewayId(env: NodeJS.ProcessEnv = process.env): string {
  return optionalEnvValue(env, 'ACP_GATEWAY_ID', 'CP_GATEWAY_ID') ?? DEFAULT_GATEWAY_ID
}

async function consulKvGet(key: string): Promise<string | undefined> {
  const result = await execProcess(['consul', 'kv', 'get', key])
  if (result.exitCode !== 0) {
    return undefined
  }

  const value = result.stdout.trim()
  return value.length > 0 ? value : undefined
}

async function resolveDiscordToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const envToken = optionalEnvValue(env, 'DISCORD_TOKEN', 'DISCORD_BLASTER_TOKEN')
  if (envToken !== undefined) {
    return envToken
  }

  const keys = [
    env['ACP_DISCORD_TOKEN_KV'] ?? 'cfg/dev/_global/discord/master_token',
    'cfg/dev/_global/discord/blaster_token',
  ]
  for (const key of keys) {
    const token = await consulKvGet(key)
    if (token !== undefined) {
      return token
    }
  }

  throw new CliServerError(
    'Missing Discord token: set DISCORD_TOKEN or DISCORD_BLASTER_TOKEN, ' +
      'or make Consul key cfg/dev/_global/discord/master_token available'
  )
}

function writeServerProcessLog(event: string, details?: Record<string, unknown>): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  process.stderr.write(`${new Date().toISOString()} [acp-server] INFO ${event}${suffix}\n`)
}

async function startGatewayInProcess(
  options: AcpServerCliOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<GatewayDiscordApp> {
  const app = new GatewayDiscordApp({
    acpBaseUrl: `http://${options.host}:${options.port}`,
    gatewayId: resolveGatewayId(env),
    discordToken: await resolveDiscordToken(env),
    maxChars: envNumber(['DISCORD_MAX_CHARS'], DEFAULT_MAX_CHARS),
    bindingsRefreshMs: envNumber(['ACP_BINDINGS_REFRESH_MS'], DEFAULT_BINDINGS_REFRESH_MS),
    deliveryPollMs: envNumber(['ACP_DELIVERY_POLL_MS'], DEFAULT_DELIVERY_POLL_MS),
    deliveryIdleMs: envNumber(['ACP_DELIVERY_IDLE_MS'], DEFAULT_DELIVERY_IDLE_MS),
  })
  await app.start()
  return app
}

async function serverForeground(args: readonly string[]): Promise<void> {
  process.env['ACP_REAL_HRC_LAUNCHER'] ??= '1'

  const serverArgs = stripLifecycleArgs(args)
  const resolved = resolveCliOptions(serverArgs)
  if (resolved.help) {
    printText(renderServerHelp())
    return
  }

  const paths = resolveAcpServerPaths()
  await mkdir(dirname(paths.pidPath), { recursive: true })

  let server: Awaited<ReturnType<typeof startAcpServeBin>> | undefined
  let gateway: GatewayDiscordApp | undefined
  try {
    server = await startAcpServeBin(resolved.options)
    await writeFile(paths.pidPath, `${process.pid}\n`)

    const discordEnabled = !gatewayDisabled(args)
    if (discordEnabled) {
      gateway = await startGatewayInProcess(resolved.options)
    }

    writeServerProcessLog('server.listening', {
      endpoint: `http://${resolved.options.host}:${resolved.options.port}`,
      pid: process.pid,
      discordGateway: discordEnabled ? resolveGatewayId() : null,
    })
    process.stderr.write(`${server.startupLine}\n`)

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) {
        return
      }
      shuttingDown = true
      await gateway?.stop()
      await server?.shutdown()
      try {
        await unlink(paths.pidPath)
      } catch {}
      process.exit(0)
    }

    process.on('SIGHUP', () => {})
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  } catch (error) {
    await gateway?.stop()
    await server?.shutdown()
    try {
      await unlink(paths.pidPath)
    } catch {}
    if (error instanceof WrkqSchemaMissingError) {
      throw new CliServerError(
        `${error.message}\nRequired migration: 000013_task_workflow_schema.sql`
      )
    }
    throw error
  }
}

async function daemonizeAndWait(args: readonly string[], timeoutMs = 5_000): Promise<number> {
  const paths = resolveAcpServerPaths()
  const { host, port } = resolveStatusEndpoint(args)
  await mkdir(paths.runtimeRoot, { recursive: true })
  await mkdir(dirname(paths.logPath), { recursive: true })

  const logFd = openSync(paths.logPath, 'a')
  const proc = Bun.spawn(
    ['bun', process.argv[1] ?? import.meta.path, 'server', 'serve', ...stripLifecycleArgs(args)],
    {
      detached: true,
      stdout: logFd,
      stderr: logFd,
      stdin: 'ignore',
      env: { ...process.env },
    }
  )

  proc.unref()
  await writeFile(paths.pidPath, `${proc.pid}\n`)

  const ready = await waitForCondition(() => isTcpResponsive(host, port), timeoutMs)
  if (!ready) {
    throw new CliServerError(
      `daemon did not become responsive within ${timeoutMs}ms (pid ${proc.pid}); log at ${paths.logPath}`
    )
  }

  process.stderr.write(`acp: daemon started (pid ${proc.pid}), log at ${paths.logPath}\n`)
  return proc.pid
}

async function stopServerProcess(
  args: readonly string[],
  options?: {
    timeoutMs?: number | undefined
    force?: boolean | undefined
    allowNotRunning?: boolean | undefined
  }
): Promise<void> {
  const paths = resolveAcpServerPaths()
  const { host, port } = resolveStatusEndpoint(args)
  const pid = readPidFile(paths.pidPath)
  const endpointResponsive = await isTcpResponsive(host, port)

  if (pid === undefined) {
    if (!endpointResponsive || options?.allowNotRunning) {
      return
    }
    throw new CliServerError(
      `daemon is responsive on http://${host}:${port}, but pid file is missing at ${paths.pidPath}`
    )
  }

  const timeoutMs = options?.timeoutMs ?? 5_000
  const force = options?.force ?? false

  if (!isLiveProcess(pid)) {
    try {
      await unlink(paths.pidPath)
    } catch {}
    if (!endpointResponsive || options?.allowNotRunning) {
      return
    }
    throw new CliServerError(`daemon endpoint is responsive, but pid ${pid} is not alive`)
  }

  process.kill(pid, 'SIGTERM')
  let stopped = await waitForCondition(
    async () => !isLiveProcess(pid) && !(await isTcpResponsive(host, port)),
    timeoutMs
  )

  if (!stopped && force) {
    process.kill(pid, 'SIGKILL')
    stopped = await waitForCondition(
      async () => !isLiveProcess(pid) && !(await isTcpResponsive(host, port)),
      timeoutMs
    )
  }

  if (!stopped) {
    throw new CliServerError(
      `daemon pid ${pid} did not stop within ${timeoutMs}ms${force ? ' after SIGTERM/SIGKILL' : ''}`
    )
  }

  try {
    await unlink(paths.pidPath)
  } catch {}
}

export async function runServerCommand(args: string[]): Promise<void> {
  const command = args[0]?.startsWith('-') ? undefined : args[0]
  const rest = command === undefined ? args : args.slice(1)

  if (command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')) {
    printText(renderServerHelp())
    return
  }

  if (command === undefined || command === 'start') {
    const mode = resolveServerMode(rest, 'foreground')
    const timeoutMs = parseTimeoutMs(rest, 5_000)
    const status = await collectAcpServerStatus(rest)
    if (status.running) {
      throw new CliServerError(
        `daemon already running at ${status.endpoint} (pid ${status.pid ?? 'unknown'})`
      )
    }

    const owner = await detectLaunchdOwner()
    if (owner !== null) {
      await launchctlKickstart(owner)
      process.stderr.write(`acp: launchd service started via ${owner.serviceTarget}\n`)
      return
    }

    if (mode === 'daemon') {
      await daemonizeAndWait(rest, timeoutMs)
      return
    }
    await serverForeground(rest)
    return
  }

  if (command === 'serve') {
    const status = await collectAcpServerStatus(rest)
    if (status.running) {
      throw new CliServerError(
        `daemon already running at ${status.endpoint} (pid ${status.pid ?? 'unknown'})`
      )
    }
    await serverForeground(rest)
    return
  }

  if (command === 'stop') {
    const before = await collectAcpServerStatus(rest)
    if (!before.running && before.pid === undefined) {
      process.stderr.write('acp: daemon is not running\n')
      return
    }

    const owner = await detectLaunchdOwner()
    if (owner !== null) {
      throw new CliServerError(
        `daemon is supervised by launchd (${owner.serviceTarget}); launchd will respawn it. ` +
          `To stop permanently: launchctl unload -w ~/Library/LaunchAgents/${owner.label}.plist`
      )
    }

    await stopServerProcess(rest, {
      timeoutMs: parseTimeoutMs(rest, 5_000),
      force: hasFlag(rest, '--force'),
      allowNotRunning: true,
    })
    process.stderr.write('acp: daemon stopped\n')
    return
  }

  if (command === 'restart') {
    const owner = await detectLaunchdOwner()
    if (owner !== null) {
      await launchctlKickstart(owner, { kill: true })
      process.stderr.write(`acp: launchd service restarted via ${owner.serviceTarget}\n`)
      return
    }

    const mode = resolveServerMode(rest, 'daemon')
    const timeoutMs = parseTimeoutMs(rest, 5_000)
    await stopServerProcess(rest, {
      timeoutMs: parseTimeoutMs(rest, 5_000),
      force: hasFlag(rest, '--force'),
      allowNotRunning: true,
    })
    if (mode === 'foreground') {
      await serverForeground(rest)
      return
    }
    await daemonizeAndWait(rest, timeoutMs)
    process.stderr.write('acp: daemon restarted\n')
    return
  }

  if (command === 'status') {
    const status = await collectAcpServerStatus(rest)
    if (hasFlag(rest, '--json')) {
      printJson(status)
    } else {
      printText(formatAcpServerStatus(status))
    }
    return
  }

  if (command === 'health') {
    const status = await collectAcpServerStatus(rest)
    if (!status.running) {
      throw new CliServerError(`ACP server is not responsive at ${status.endpoint}`)
    }
    printText('ok')
    return
  }

  throw new CliUsageError(`unknown server subcommand: ${command}`)
}
