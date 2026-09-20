#!/usr/bin/env bun
import { startMailInjector } from './index.js'
import { inspectMailEnvelope } from './inspect.js'

const statePath = process.env['HRC_MAIL_INJECTOR_STATE_PATH']
if (statePath === undefined || statePath === '') {
  throw new Error('HRC_MAIL_INJECTOR_STATE_PATH is required')
}

const args = process.argv.slice(2)
if (args[0] === 'inspect') {
  const envelopeId = args[1]
  if (args.length !== 2 || envelopeId === undefined) {
    throw new Error('usage: hrc-mail-injector inspect EN-xxxxx')
  }
  console.log(JSON.stringify(await inspectMailEnvelope({ statePath, envelopeId }), null, 2))
  process.exit(0)
}
if (args.length > 0) throw new Error('usage: hrc-mail-injector [inspect EN-xxxxx]')

const socketPath = process.env['HRC_SOCKET_PATH']
if (socketPath === undefined || socketPath === '') throw new Error('HRC_SOCKET_PATH is required')
const sourcePath = process.env['HRC_MAIL_KICKER_STATE_PATH']
const injector = await startMailInjector({
  socketPath,
  statePath,
  ...(sourcePath === undefined || sourcePath === '' ? {} : { importFrom: { sourcePath } }),
  nodeId: process.env['HRC_NODE_ID'] ?? 'max3',
})

console.log(
  JSON.stringify({
    status: 'running',
    subscriber: 'mail',
    statePath: injector.statePath,
    importMarker: injector.importMarker,
  })
)
const stop = async () => {
  await injector.stop()
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
await new Promise<void>(() => {})
