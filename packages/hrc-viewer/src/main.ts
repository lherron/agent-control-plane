#!/usr/bin/env bun

import { writeLogLine } from 'acp-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

import { createGhostmuxManager } from './ghostmux.js'
import { HrcViewer, type ViewerLog } from './viewer.js'

const STARTUP_RETRY_MS = 4_000

const log: ViewerLog = (level, event, fields = {}) =>
  writeLogLine({
    level: level === 'WARN' ? 'warn' : 'info',
    component: 'hrc-viewer',
    event,
    data: fields,
  })

async function waitForClient(signal: AbortSignal): Promise<HrcClient> {
  while (!signal.aborted) {
    try {
      return new HrcClient(discoverSocket())
    } catch (error) {
      log('WARN', 'broker_headless_viewer.daemon_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
      await Bun.sleep(STARTUP_RETRY_MS)
    }
  }
  throw new Error('hrc-viewer stopped before the HRC socket became available')
}

export async function runViewer(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Usage: hrc-viewer

Per-user Ghostty presentation sidecar for the local HRC daemon.

Environment:
  HRC_RUNTIME_DIR              HRC socket directory
  HRC_VIEWER_LINGER_SECONDS    Pane reap delay (default: 300)`)
    return
  }
  const abortController = new AbortController()
  const stop = () => abortController.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    const client = await waitForClient(abortController.signal)
    const viewer = new HrcViewer({
      client,
      ghostmux: createGhostmuxManager(),
      log,
    })
    await viewer.run(abortController.signal)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) {
  await runViewer()
}
