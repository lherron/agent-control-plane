#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { openCoordinationStore } from 'coordination-substrate'
import { WrkqSchemaMissingError, openWrkqStore } from 'wrkq-lib'

import { createAcpServer } from './create-acp-server.js'

const DEFAULT_COORD_DB_PATH = '/Users/lherron/praesidium/var/db/acp-coordination.db'
const DEFAULT_PORT = 18470
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ACTOR = 'acp-server'

export interface AcpServerCliOptions {
  wrkqDbPath: string
  coordDbPath: string
  host: string
  port: number
  actor: string
}

type ParsedCliArgs = {
  help: boolean
  options: Partial<AcpServerCliOptions>
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const options: Partial<AcpServerCliOptions> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { help: true, options }
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
      case '--wrkq-db-path':
        options.wrkqDbPath = requireValue(arg)
        break
      case '--coord-db-path':
        options.coordDbPath = requireValue(arg)
        break
      case '--host':
        options.host = requireValue(arg)
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

  return { help: false, options }
}

export function resolveCliOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): { help: boolean; options: AcpServerCliOptions } {
  const parsed = parseCliArgs(args)
  const wrkqDbPath = parsed.options.wrkqDbPath ?? env['ACP_WRKQ_DB_PATH'] ?? env['WRKQ_DB_PATH']
  if (!parsed.help && (wrkqDbPath === undefined || wrkqDbPath.trim().length === 0)) {
    throw new Error('ACP_WRKQ_DB_PATH or WRKQ_DB_PATH is required')
  }

  const envPort = Number.parseInt(env['ACP_PORT'] ?? '', 10)

  return {
    help: parsed.help,
    options: {
      wrkqDbPath: wrkqDbPath?.trim() ?? '',
      coordDbPath: parsed.options.coordDbPath ?? env['ACP_COORD_DB_PATH'] ?? DEFAULT_COORD_DB_PATH,
      host: parsed.options.host ?? env['ACP_HOST'] ?? DEFAULT_HOST,
      port: parsed.options.port ?? (Number.isFinite(envPort) ? envPort : DEFAULT_PORT),
      actor: parsed.options.actor ?? env['ACP_ACTOR'] ?? env['WRKQ_ACTOR'] ?? DEFAULT_ACTOR,
    },
  }
}

export function formatStartupLine(options: AcpServerCliOptions): string {
  return `acp-server listening on http://${options.host}:${options.port} wrkq.db = ${options.wrkqDbPath} coord.db = ${options.coordDbPath}`
}

export function renderHelp(): string {
  return [
    'acp-server — Bun.serve wrapper around packages/acp-server',
    '',
    'Usage:',
    '  acp-server [--wrkq-db-path <path>] [--coord-db-path <path>] [--host <host>] [--port <port>] [--actor <agentId>]',
    '',
    'Environment:',
    '  ACP_WRKQ_DB_PATH  Defaults to WRKQ_DB_PATH',
    `  ACP_COORD_DB_PATH Defaults to ${DEFAULT_COORD_DB_PATH}`,
    `  ACP_HOST          Defaults to ${DEFAULT_HOST}`,
    `  ACP_PORT          Defaults to ${DEFAULT_PORT}`,
    `  ACP_ACTOR         Defaults to WRKQ_ACTOR or ${DEFAULT_ACTOR}`,
  ].join('\n')
}

export async function startAcpServeBin(options: AcpServerCliOptions): Promise<{
  shutdown(): Promise<void>
  startupLine: string
}> {
  await mkdir(dirname(options.coordDbPath), { recursive: true })

  const wrkqStore = openWrkqStore({
    dbPath: options.wrkqDbPath,
    actor: { agentId: options.actor },
  })
  const coordStore = openCoordinationStore(options.coordDbPath)
  const acpServer = createAcpServer({
    wrkqStore,
    coordStore,
  })
  const bunServer = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: acpServer.handler,
  })

  let closed = false
  return {
    startupLine: formatStartupLine(options),
    async shutdown(): Promise<void> {
      if (closed) {
        return
      }

      closed = true
      bunServer.stop(true)
      wrkqStore.close()
      coordStore.close()
    },
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let runtime: Awaited<ReturnType<typeof startAcpServeBin>> | undefined

  try {
    const resolved = resolveCliOptions(args)
    if (resolved.help) {
      console.log(renderHelp())
      return 0
    }

    runtime = await startAcpServeBin(resolved.options)
    console.log(runtime.startupLine)

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      if (runtime !== undefined) {
        await runtime.shutdown()
      }
      process.exit(0)
    }

    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
    return 0
  } catch (error) {
    if (runtime !== undefined) {
      await runtime.shutdown()
    }

    if (error instanceof WrkqSchemaMissingError) {
      console.error(`${error.message}\nRequired migration: 000013_task_workflow_schema.sql`)
      return 1
    }

    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await main()
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}
