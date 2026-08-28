import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { HrcClient } from 'hrc-sdk'
import { type HrcServer, createHrcServer } from 'hrc-server'

export type HrcSupportPaths = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
}

export type ScratchHrcDaemon = HrcSupportPaths & {
  scratchRoot: string
  databasePath: string
  client: HrcClient
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
  prefix = 'acp-e2e-real-hrc-'
): Promise<ScratchHrcDaemon> {
  const scratchRoot = await mkdtemp(join(tmpdir(), prefix))
  const runtimeRoot = join(scratchRoot, 'runtime')
  const stateRoot = join(scratchRoot, 'state')
  const socketPath = join(runtimeRoot, 'hrc.sock')
  const databasePath = join(stateRoot, 'state.sqlite')
  let server: HrcServer | undefined

  try {
    assertScratchHrcPaths({ runtimeRoot, stateRoot, socketPath })
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath: join(runtimeRoot, 'server.lock'),
      spoolDir: join(runtimeRoot, 'spool'),
      dbPath: databasePath,
      tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
      otelListenerEnabled: false,
      staleGenerationEnabled: false,
      tmuxAgingEnabled: false,
      headlessCodexBrokerEnabled: false,
      claudeCodeTmuxBrokerEnabled: false,
      codexCliTmuxBrokerEnabled: false,
      piTuiTmuxBrokerEnabled: false,
      hrcMailKickerEnabled: false,
    })
  } catch (error) {
    await server?.stop().catch(() => undefined)
    await rm(scratchRoot, { recursive: true, force: true })
    throw error
  }

  let closed = false
  return {
    scratchRoot,
    runtimeRoot,
    stateRoot,
    socketPath,
    databasePath,
    client: new HrcClient(socketPath),
    close: async () => {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      try {
        await server.stop()
      } catch (error) {
        errors.push(error)
      }
      try {
        await rm(scratchRoot, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'scratch HRC teardown failed')
      }
    },
  }
}
