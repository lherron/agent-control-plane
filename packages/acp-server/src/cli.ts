#!/usr/bin/env bun
import { writeLogLine } from 'acp-core'
import { startAcpServeBin } from './serve-runtime.js'
import { renderHelp, resolveCliOptions } from './server-config.js'

// Existing executable-module exports are retained for external compatibility.
// Package and internal consumers import each responsibility from its owner.
export {
  type AcpServerCliOptions,
  bindAcpHostListeners,
  formatStartupConfig,
  isEnabledEnvFlag,
  parseCliArgs,
  renderHelp,
  resolveAttachmentBaseUrl,
  resolveBindHosts,
  resolveCliOptions,
} from './server-config.js'
export {
  type ResolveLauncherDepsOptions,
  resolveLauncherDeps,
  resolveRealLauncherAgentRoot,
  resolveRealLauncherPlacement,
} from './launcher-deps.js'
export { startAcpServeBin } from './serve-runtime.js'

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let runtime: Awaited<ReturnType<typeof startAcpServeBin>> | undefined

  try {
    const resolved = resolveCliOptions(args)
    if (resolved.help) {
      console.log(renderHelp())
      return 0
    }

    runtime = await startAcpServeBin(resolved.options)
    writeLogLine({
      level: 'info',
      component: 'acp-server',
      event: 'server.listening',
      data: { pid: process.pid, ...runtime.startupConfig },
    })

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

    writeLogLine({
      level: 'error',
      component: 'acp-server',
      event: 'server.start_failed',
      err: error,
    })
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await main()
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}
