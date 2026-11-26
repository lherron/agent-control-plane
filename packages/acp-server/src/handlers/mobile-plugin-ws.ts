/**
 * `plugin.subscribe` / `plugin.unsubscribe` on the mobile dashboard socket
 * (features/mobile-plugin-pages.md): each subscription is one `cardo <mount> watch --args -
 * --raw` child whose stdout lines go to the phone verbatim, in `plugin.line` frames
 * keyed by the phone's subscription id. The child dies on unsubscribe or socket close.
 * The socket's upgrade was admitted in the ordinary mobile `bearer` class.
 *
 * Phone → ACP: {type: "plugin.subscribe", id, page: "<plugin>:<name>", mount, args}
 *              {type: "plugin.unsubscribe", id}
 * ACP → phone: {type: "plugin.line", id, line}
 *              {type: "plugin.closed", id, reason: "unsubscribed" | "socket_closed" | "exited",
 *               exitCode?, error?}
 *              {type: "plugin.error", id, error: {code, message}}  (nothing was started)
 */
import { writeLogLine } from 'acp-core'

import { mountRefusal, parseAddress } from '../plugin-pages/allowlist.js'
import { type CardoWatch, cardoWatch } from '../plugin-pages/cardo.js'
import { readPluginPage } from '../plugin-pages/manifest.js'
import { type MobileWebSocketLike, sendMobileJsonEnvelope } from './mobile-ws.js'

/** The CLI's `watch` needs a bound; a subscription that reaches it closes as `exited`. */
const WATCH_SECONDS = 24 * 60 * 60
const SUBSCRIPTIONS_PER_SOCKET_MAX = 32

type Subscription = { watch?: CardoWatch | undefined; closing?: string | undefined }
const sockets = new WeakMap<object, Map<string, Subscription>>()

function subscriptionsOf(ws: MobileWebSocketLike): Map<string, Subscription> {
  let map = sockets.get(ws.data)
  if (map === undefined) {
    map = new Map()
    sockets.set(ws.data, map)
  }
  return map
}

function refuse(ws: MobileWebSocketLike, id: unknown, code: string, message: string): void {
  sendMobileJsonEnvelope(ws, { type: 'plugin.error', id, error: { code, message } })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

async function subscribe(ws: MobileWebSocketLike, frame: Record<string, unknown>): Promise<void> {
  const id = frame['id']
  const subscriptions = subscriptionsOf(ws)
  const address = parseAddress(frame['mount'])
  const page = typeof frame['page'] === 'string' ? frame['page'].split(':') : []
  if (
    typeof id !== 'string' ||
    id === '' ||
    address === undefined ||
    page.length !== 2 ||
    !isObject(frame['args'])
  ) {
    return refuse(ws, id, 'invalid_request', 'plugin.subscribe is {id, page, mount, args}')
  }
  if (subscriptions.has(id)) return refuse(ws, id, 'invalid_request', `subscription ${id} is open`)
  if (subscriptions.size >= SUBSCRIPTIONS_PER_SOCKET_MAX) {
    return refuse(ws, id, 'invalid_request', 'too many open subscriptions')
  }
  // Hold the id while the manifest is read, so an early unsubscribe is honoured.
  const subscription: Subscription = {}
  subscriptions.set(id, subscription)
  const options = ws.data.deps.pluginPages
  const found = await readPluginPage(options, page[0] as string, page[1] as string)
  const refusal = found === undefined ? 'page_not_found' : mountRefusal(found.mounts, address.mount)
  if (refusal !== undefined || subscription.closing !== undefined) {
    subscriptions.delete(id)
    if (refusal !== undefined) {
      writeLogLine({
        level: 'info',
        component: 'mobile-plugins',
        event: 'plugin.subscribe_refused',
        data: { page: frame['page'], mount: address.mount, code: refusal },
      })
      refuse(ws, id, refusal, `${frame['page']} may not subscribe on ${address.mount}`)
    } else {
      sendMobileJsonEnvelope(ws, { type: 'plugin.closed', id, reason: subscription.closing })
    }
    return
  }
  subscription.watch = cardoWatch({
    bin: options.cardoBin,
    address,
    args: frame['args'],
    forSeconds: WATCH_SECONDS,
    onLine: (line) => sendMobileJsonEnvelope(ws, { type: 'plugin.line', id, line }),
    onExit: (exitCode, stderr) => {
      subscriptions.delete(id)
      const reason = subscription.closing ?? 'exited'
      writeLogLine({
        level: 'info',
        component: 'mobile-plugins',
        event: 'plugin.watch_closed',
        data: { page: frame['page'], mount: address.mount, reason, exitCode, stderr },
      })
      sendMobileJsonEnvelope(ws, {
        type: 'plugin.closed',
        id,
        reason,
        ...(reason === 'exited' ? { exitCode } : {}),
        ...(reason === 'exited' && exitCode === 75
          ? { error: { code: 'mount_unavailable', message: `no live mount ${address.mount}` } }
          : {}),
      })
    },
  })
}

function close(subscription: Subscription, reason: string): void {
  subscription.closing ??= reason
  subscription.watch?.kill()
}

/** Handles a plugin frame; `false` means the frame is not a plugin frame. */
export function handlePluginWebSocketFrame(ws: MobileWebSocketLike, frame: unknown): boolean {
  if (!isObject(frame)) return false
  if (frame['type'] === 'plugin.subscribe') {
    void subscribe(ws, frame).catch((error) =>
      refuse(
        ws,
        frame['id'],
        'relay_failed',
        error instanceof Error ? error.message : String(error)
      )
    )
    return true
  }
  if (frame['type'] === 'plugin.unsubscribe') {
    const subscription =
      typeof frame['id'] === 'string' ? subscriptionsOf(ws).get(frame['id']) : undefined
    if (subscription === undefined) {
      refuse(ws, frame['id'], 'unknown_subscription', 'no open subscription with that id')
    } else {
      close(subscription, 'unsubscribed')
    }
    return true
  }
  return false
}

/** Kills every watch child of a closing socket. */
export function closePluginSubscriptions(ws: MobileWebSocketLike): void {
  for (const subscription of subscriptionsOf(ws).values()) close(subscription, 'socket_closed')
}
