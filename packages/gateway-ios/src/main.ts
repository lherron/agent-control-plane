#!/usr/bin/env bun

/**
 * Standalone dev binary for gateway-ios.
 *
 * Resolves config from environment, creates the module, starts it,
 * and prints the health URL. Graceful shutdown on SIGINT/SIGTERM.
 */

import { resolveConfig } from './config.js'
import { createLogger } from './logger.js'
import { createGatewayIosModule } from './module.js'

const log = createLogger({ component: 'gateway-ios-main' })

async function main() {
  const config = resolveConfig()

  const mod = createGatewayIosModule({
    hrcSocketPath: config.hrcSocketPath,
    host: config.host,
    port: config.port,
    bearerToken: config.bearerToken,
    gatewayId: config.gatewayId,
  })

  const { host, port } = await mod.start()

  log.info('gateway.ready', {
    message: `gateway-ios listening on http://${host}:${port}`,
    data: { healthUrl: `http://${host}:${port}/v1/health` },
  })

  const shutdown = async () => {
    log.info('gateway.shutdown_signal')
    await mod.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  log.error('gateway.fatal', {
    message: 'Fatal gateway error',
    err: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  })
  process.exit(1)
})
