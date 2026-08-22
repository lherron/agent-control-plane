/**
 * GET /v1/mobile/sessions/:hostSessionId/attach-info
 *
 * HRCMac embedded-terminal spec §3.2 (rev 3). Hands a local client everything it
 * needs to fast-attach an embedded libghostty surface to a session's durable
 * broker-tmux, by PROXYING hrc-server's existing attach descriptor. Nothing about
 * the attach command is re-derived here: `argv` is hrc-server's, and `socketPath`
 * / `target` are read back out of that same argv rather than recomputed from
 * runtime state, so there is exactly one place that knows how to build an attach.
 *
 * Two gates, both fail-closed:
 *  - the socket peer must be loopback (an unobservable peer is not loopback), and
 *  - the session must be owned by the hrc node this gateway is co-resident with —
 *    which is exactly "the local hrc control socket knows this hostSessionId",
 *    since `listSessions` reads that node's own store and never federated
 *    projections.
 * Either failure is `404 {reason: 'not_local'}`, which the app treats as "render
 * the frame timeline instead". A local session that simply has nothing to attach
 * to (no durable lease, dead runtime, headless-without-tui) is `409
 * {reason: 'not_attachable'}`.
 */

import { basename, isAbsolute } from 'node:path'
import { HrcDomainError } from 'hrc-core'

import { badRequest, json } from '../http.js'
import { isLoopbackPeer } from '../routing/peer.js'

import type { AcpHrcClient } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'
import { findLocalMobileSessionByHostSessionId } from './mobile.js'

type ParsedTmuxAttach = {
  socketPath: string
  target: string
}

function notLocal(detail: Record<string, unknown>): Response {
  return json({ local: false, reason: 'not_local', ...detail }, 404)
}

function notAttachable(detail: Record<string, unknown>): Response {
  return json({ local: false, reason: 'not_attachable', ...detail }, 409)
}

/**
 * Read `socketPath` and `target` back out of hrc-server's attach argv.
 *
 * The broker attach descriptor is exactly `<absolute path to tmux> -S <socket>
 * attach-session -t <target>` (hrc-server `attachRuntime`). A bare `tmux` is
 * retained temporarily for rolling compatibility with an older local hrc-server.
 * Matching that shape positionally keeps the descriptor the single source of
 * truth; anything else (a ghostty surface descriptor, a future argv shape) is
 * reported as not-attachable rather than guessed at, because a mis-parsed
 * socket/target would attach the wrong pane.
 */
export function parseTmuxAttachArgv(argv: readonly string[]): ParsedTmuxAttach | undefined {
  if (argv.length !== 6) {
    return undefined
  }
  const [command, socketFlag, socketPath, subcommand, targetFlag, target] = argv
  const isTmuxCommand =
    command === 'tmux' ||
    (command !== undefined && isAbsolute(command) && basename(command) === 'tmux')
  if (!isTmuxCommand || socketFlag !== '-S' || subcommand !== 'attach-session') {
    return undefined
  }
  if (targetFlag !== '-t') {
    return undefined
  }
  if (
    socketPath === undefined ||
    socketPath.length === 0 ||
    target === undefined ||
    target.length === 0
  ) {
    return undefined
  }
  return { socketPath, target }
}

export const handleMobileAttachInfo: RouteHandler = async ({ deps, params, peer }) => {
  // Gate first: a non-local caller learns nothing about which sessions exist.
  if (!isLoopbackPeer(peer)) {
    return notLocal({ message: 'attach-info is served to loopback callers only' })
  }

  const hostSessionId = params['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    badRequest('hostSessionId path segment is required', { field: 'hostSessionId' })
  }

  const hrcClient: AcpHrcClient | undefined = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const resolved = await findLocalMobileSessionByHostSessionId(hrcClient, hostSessionId)
  if (resolved === undefined) {
    // Not an error: the session belongs to another node (or does not exist), and
    // the app's answer to both is the same — use the frame timeline.
    return notLocal({ hostSessionId, message: 'session is not owned by this hrc node' })
  }

  const { record, runtime } = resolved
  if (runtime === undefined) {
    return notAttachable({
      hostSessionId,
      generation: record.generation,
      message: 'session has no runtime to attach to',
    })
  }

  let descriptor: Awaited<ReturnType<AcpHrcClient['getAttachDescriptor']>>
  try {
    descriptor = await hrcClient.getAttachDescriptor(runtime.runtimeId)
  } catch (error) {
    // hrc-server raises runtime_unavailable for exactly the not-attachable cases
    // the spec enumerates (no durable broker lease, dead/reconciled runtime,
    // non-interactive transport). Everything else is reported the same way: the
    // app's only decision is terminal-vs-timeline.
    return notAttachable({
      hostSessionId,
      runtimeId: runtime.runtimeId,
      ...(error instanceof HrcDomainError ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const parsed = parseTmuxAttachArgv(descriptor.argv)
  if (descriptor.transport !== 'tmux' || parsed === undefined) {
    return notAttachable({
      hostSessionId,
      runtimeId: runtime.runtimeId,
      transport: descriptor.transport,
      message: 'attach descriptor is not an embeddable tmux attach',
    })
  }

  return json({
    local: true,
    argv: descriptor.argv,
    socketPath: parsed.socketPath,
    target: parsed.target,
    bindingFence: descriptor.bindingFence,
  })
}
