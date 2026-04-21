#!/usr/bin/env node

import { log, startGateway } from './app.js'

startGateway().catch((error) => {
  log.error('gw.fatal', {
    message: 'Fatal gateway error',
    err: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  })
  process.exit(1)
})
