import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { HrcClient } from 'hrc-sdk'

import { ownerBinary } from '../../../../scripts/lib/owner-binaries.js'

const SCRATCH_PARENT = '/tmp'

export type HrcSupportPaths = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
}

export type ScratchHrcDaemon = HrcSupportPaths & {
  scratchRoot: string
  databasePath: string
  client: HrcClient
  readonly running: boolean
  start(): Promise<void>
  stop(): Promise<void>
  close(): Promise<void>
}

export async function runAllTeardownSteps(steps: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'real-HRC E2E teardown failed')
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (!existsSync(absolute)) return absolute
  try {
    return realpathSync(absolute)
  } catch {
    // Bun's realpath currently rejects live Unix sockets on macOS (EOPNOTSUPP).
    // Their resolved absolute pathname is still sufficient for the exact guard.
    return absolute
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const canonicalLeft = canonicalPath(left)
  const canonicalRight = canonicalPath(right)
  const leftToRight = relative(canonicalLeft, canonicalRight)
  const rightToLeft = relative(canonicalRight, canonicalLeft)
  return (
    leftToRight === '' ||
    (!leftToRight.startsWith('..') && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
  )
}

export function resolveProductionHrcPaths(env: NodeJS.ProcessEnv = process.env): HrcSupportPaths {
  const praesidiumRoot = resolve(env['PRAESIDIUM_ROOT'] ?? join(homedir(), 'praesidium'))
  const runtimeRoot = resolve(env['HRC_RUNTIME_DIR'] ?? join(praesidiumRoot, 'var/run/hrc'))
  const stateRoot = resolve(env['HRC_STATE_DIR'] ?? join(praesidiumRoot, 'var/state/hrc'))
  return {
    runtimeRoot,
    stateRoot,
    socketPath: join(runtimeRoot, 'hrc.sock'),
  }
}

export function assertScratchHrcPaths(
  paths: HrcSupportPaths,
  productionPaths: HrcSupportPaths = resolveProductionHrcPaths()
): void {
  const protectedPaths = [
    productionPaths.runtimeRoot,
    productionPaths.stateRoot,
    productionPaths.socketPath,
  ]
  const configuredPaths = [paths.runtimeRoot, paths.stateRoot, paths.socketPath]
  if (
    configuredPaths.some((configured) =>
      protectedPaths.some((production) => pathsOverlap(configured, production))
    )
  ) {
    throw new Error('refusing to use production HRC support paths for the ACPS E2E suite')
  }
}

export async function createScratchHrcDaemon(
  prefix = 'acp-e2e-real-hrc-',
  options: { start?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<ScratchHrcDaemon> {
  // HRC's worst-case btmux socket must fit sockaddr_un; macOS $TMPDIR is too long.
  const scratchRoot = await mkdtemp(join(SCRATCH_PARENT, prefix))
  const runtimeRoot = join(scratchRoot, 'runtime')
  const stateRoot = join(scratchRoot, 'state')
  const socketPath = join(runtimeRoot, 'hrc.sock')
  const databasePath = join(stateRoot, 'state.sqlite')
  const logPath = join(scratchRoot, 'hrc.log')
  const wrkqDatabase = join(scratchRoot, 'wrkq.db')
  const client = new HrcClient(socketPath)
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<void> | undefined
  let spawnError: Error | undefined
  let closed = false

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child?.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const groupAlive = (): boolean => {
    if (child?.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return false
    }
  }
  let binaryPath: string
  let env: NodeJS.ProcessEnv
  const stop = async (): Promise<void> => {
    signalGroup('SIGTERM')
    for (let i = 0; i < 50 && groupAlive(); i++) await Bun.sleep(100)
    if (groupAlive()) signalGroup('SIGKILL')
    await exited
    for (let i = 0; i < 50 && groupAlive(); i++) await Bun.sleep(100)
    if (groupAlive()) throw new Error(`scratch HRC process group survived: ${child?.pid}`)
    console.info(`[scratch-hrc] stopped pid=${child?.pid} root=${scratchRoot}`)
    child = undefined
    exited = undefined
  }
  const close = async (): Promise<void> => {
    if (closed) return
    await runAllTeardownSteps([
      stop,
      async () => await rm(scratchRoot, { recursive: true, force: true }),
    ])
    closed = true
  }
  const start = async (): Promise<void> => {
    if (closed) throw new Error('scratch HRC is closed')
    if (child !== undefined) throw new Error('scratch HRC is already running')
    spawnError = undefined
    const logFd = openSync(logPath, 'a')
    try {
      // detached creates a fresh session (setsid), as in dev-env.sh. Keep the
      // foreground harness guard intact: this suite must run in a real terminal.
      child = spawn(binaryPath, ['server', 'serve'], {
        env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      })
      exited = new Promise((resolveExit) => {
        child?.once('error', (error) => {
          spawnError = error
          resolveExit()
        })
        child?.once('exit', () => resolveExit())
      })
    } finally {
      closeSync(logFd)
    }
    console.info(
      `[scratch-hrc] pid=${child.pid} binary=${binaryPath} root=${scratchRoot} HRC_WRKQ_DB=${wrkqDatabase}`
    )
    let healthy = false
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        healthy = (await client.getHealth()).ok
        if (healthy) break
      } catch {
        // A socket inode alone does not prove the daemon is ready.
      }
      await Bun.sleep(100)
    }
    if (!healthy)
      throw new Error(`scratch rusthrc did not become healthy: ${readFileSync(logPath, 'utf8')}`)
  }

  try {
    assertScratchHrcPaths({ runtimeRoot, stateRoot, socketPath })
    binaryPath = realpathSync(ownerBinary('hrc'))
    if (!binaryPath.endsWith('/rusthrc'))
      throw new Error(`expected installed rusthrc: ${binaryPath}`)
    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    env = {
      ...process.env,
      ...options.env,
      PATH: `${join(homedir(), '.local/bin')}:${join(homedir(), '.bun/bin')}:${process.env['PATH'] ?? ''}`,
      HRC_RUNTIME_DIR: runtimeRoot,
      HRC_STATE_DIR: stateRoot,
      HRC_WRKQ_DB: wrkqDatabase,
      WRKQ_DB: wrkqDatabase,
      WRKQ_DB_PATH: '',
      WRKQ_DB_PATH_FILE: '',
      WRKQ_PROJECT_ROOT: 'agent-control-plane',
      WRKQD_TOKEN: '',
      WRKQD_TOKEN_FILE: '',
      HRC_WRKQD_TOKEN_FILE: '',
      HRC_STALE_GENERATION_ENABLED: '0',
      HRC_TMUX_AGING_ENABLED: '0',
      HRC_BROKER_LEASE_GC_ENABLED: '0',
      HRC_TRANSCRIPT_INDEX_ENABLED: '0',
    }
    execFileSync(process.env['WRKQADM_BIN'] ?? 'wrkqadm', ['--db', wrkqDatabase, 'init'], {
      env,
      timeout: 30_000,
    })
    if (options.start !== false) await start()
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'scratch HRC startup and teardown failed')
    }
    throw error
  }

  return {
    scratchRoot,
    runtimeRoot,
    stateRoot,
    socketPath,
    databasePath,
    client,
    get running() {
      return child !== undefined
    },
    start,
    stop,
    close,
  }
}
