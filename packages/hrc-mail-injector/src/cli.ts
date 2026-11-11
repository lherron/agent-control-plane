#!/usr/bin/env bun
import { DelivererLock, DeliveryOwner, InjectorOwnerLoop } from './delivery-owner.js'
import { startMailInjector } from './index.js'
import { inspectMailEnvelope } from './inspect.js'
import { createJsonLineLog } from './log-line.js'

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
const log = createJsonLineLog()
const flag = new DeliveryOwner(statePath)
const lock = new DelivererLock(statePath)
const loop = new InjectorOwnerLoop(
  flag,
  lock,
  () =>
    startMailInjector({
      socketPath,
      statePath,
      ...(sourcePath === undefined || sourcePath === '' ? {} : { importFrom: { sourcePath } }),
      nodeId: process.env['HRC_NODE_ID'] ?? 'max3',
    }),
  log
)
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await loop.stop()
  flag.close()
  lock.close()
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
while (!stopping) {
  await loop.step()
  await Bun.sleep(1000)
}
