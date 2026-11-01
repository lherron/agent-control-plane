/**
 * The always-on C2 controller host in ACP (T-12207; C2 rev 4 D2, D9).
 *
 * One c2-core `Controller` per ACP instance with `classify: true`, ticking on
 * every HRC observation change and at least every 15 s. ACP adds only
 * transport: the snapshot cache and its opaque revision, the bounded long
 * poll, the last-good stale snapshot, artifact resolution, and mapping c2-core
 * cards to the wire through `toWire` / `wireCard` with ACP-minted artifact ids.
 * Card policy, receipts and outcomes are c2-core's.
 */
import {
  type ActionRequest,
  type ActionResponse,
  Controller,
  PRODUCTION_VESTA,
  displayId,
  online,
  toWire,
  validateRequest,
  wireCard,
} from '@praesidium/c2-core'

import { writeLogLine } from 'acp-core'

import type { AcpHrcClient } from '../deps.js'
import { mintArtifactId, serveArtifact } from './artifacts.js'
import { type AcpC2Config, C2_DEFAULTS, defaultArtifactRoots } from './config.js'
import { type C2HrcClient, type C2HrcHost, createC2HrcHost } from './hrc-adapter.js'

export const C2_CONTROLLER_PRINCIPAL = 'system:c2-controller'
export const C2_PHONE_PRINCIPAL = 'agent:lance'
export const C2_ACTION_KINDS = [
  'reply',
  'choose',
  'compose',
  'jump',
  'delegate',
  'elucidate',
  'rotate',
  'snooze',
] as const
export const LONG_POLL_MAX_MS = 25_000

type WireBody = ReturnType<typeof toWire>
type Snapshot = { body: WireBody; revision: string; asOf: string; okAt: number; node: string }
export type C2HttpResult = { status: number; body: unknown }

export type C2Service = {
  cards(query: { after?: string | undefined; waitMs?: number | undefined }): Promise<C2HttpResult>
  act(raw: unknown): Promise<C2HttpResult>
  reconcile(requestId: string, sessionRef: string, generation: number): Promise<C2HttpResult>
  artifact(id: string): Promise<Response>
  stop(): void
}

function log(event: string, data: Record<string, unknown>): void {
  writeLogLine({ level: 'info', component: 'acp-c2', event, data })
}

export function createC2Service(config: AcpC2Config, hrcClient: AcpHrcClient): C2Service {
  const pollMs = config.pollMs ?? C2_DEFAULTS.pollMs
  const roots = config.artifactRoots ?? defaultArtifactRoots()
  const host: C2HrcHost = createC2HrcHost({
    client: hrcClient as unknown as C2HrcClient,
    vestaSeat: config.vestaSeat,
    principal: C2_CONTROLLER_PRINCIPAL,
    node: config.node,
    sweepMs: config.sweepMs ?? C2_DEFAULTS.sweepMs,
    ownsUnscoped: config.vestaSeat === PRODUCTION_VESTA,
    literalInputTimeoutMs: config.literalInputTimeoutMs ?? C2_DEFAULTS.literalInputTimeoutMs,
    log: (line) => log('c2.host', { line }),
  })
  const controller = new Controller(host, {
    vestaSeat: config.vestaSeat,
    principal: C2_CONTROLLER_PRINCIPAL,
    actor: C2_PHONE_PRINCIPAL,
    classify: true,
    ...(config.node !== undefined ? { node: config.node } : {}),
  })

  let last: Snapshot | undefined
  const waiters = new Set<() => void>()
  let refreshing: Promise<Snapshot> | null = null

  async function readSnapshot(): Promise<Snapshot> {
    const [view, node] = await Promise.all([controller.read(), host.node()])
    const body = toWire(view, mintArtifactId)
    const revision = Bun.hash(JSON.stringify(body)).toString(36)
    const snapshot: Snapshot = { body, revision, asOf: view.asOf, okAt: Date.now(), node }
    const changed = last?.revision !== revision
    last = snapshot
    if (changed) {
      for (const wake of waiters) wake()
    }
    return snapshot
  }

  function refresh(): Promise<Snapshot> {
    if (refreshing === null) {
      refreshing = readSnapshot().finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  function full(snapshot: Snapshot, reachable: boolean) {
    const ageMs = reachable ? 0 : Date.now() - snapshot.okAt
    return {
      ok: true as const,
      revision: snapshot.revision,
      asOf: snapshot.asOf,
      home: { node: snapshot.node, reachable, ageMs, stale: !reachable },
      ...snapshot.body,
      capabilities: { actions: [...C2_ACTION_KINDS], artifacts: true, longPoll: true },
    }
  }

  function toWireResponse(response: ActionResponse) {
    const { card, ...rest } = response
    return card !== undefined ? { ...rest, card: wireCard(card, mintArtifactId) } : rest
  }

  /**
   * The acted line (card-contract §6): after a delivered reply/choose/compose
   * WITH a runId, one best-effort line to the live configured Vesta seat
   * through the fenced literal input. Never retried or queued; skipped when
   * Vesta is offline; its failure never changes the action's outcome.
   */
  async function sendActedLine(request: ActionRequest, response: ActionResponse): Promise<void> {
    try {
      const view = await controller.read()
      const receipt = view.receipts.find(
        (r) =>
          r.row.id === request.requestId &&
          r.key.sessionRef === request.key.sessionRef &&
          r.key.generation === request.key.generation
      )
      const vesta = view.seatRows.find((row) => row.scopeRef === config.vestaSeat)
      const runId = response.receipt?.runId
      if (receipt === undefined || runId === undefined || vesta === undefined || !online(vesta)) {
        log('c2.acted.skipped', {
          requestId: request.requestId,
          vestaOnline: vesta !== undefined && online(vesta),
        })
        return
      }
      const cardId = response.card?.id ?? displayId(request.key)
      const line = `[c2] acted ${cardId} ${receipt.body.actionId} recommended=${receipt.body.recommended} edited=${receipt.body.edited} run=${runId}`
      const sent = await host.send(
        {
          sessionRef: vesta.sessionRef,
          hostSessionId: vesta.hostSessionId,
          generation: vesta.generation,
        },
        line,
        C2_CONTROLLER_PRINCIPAL
      )
      log('c2.acted', {
        requestId: request.requestId,
        ok: !('code' in sent),
        ...('code' in sent ? { code: sent.code } : {}),
      })
    } catch (error) {
      log('c2.acted.failed', { requestId: request.requestId, error: String(error) })
    }
  }

  const stopController = controller.start()
  const poll = setInterval(() => {
    void refresh().catch(() => undefined)
  }, pollMs)
  void refresh().catch((error) => log('c2.observe.failed', { error: String(error) }))

  return {
    async cards({ after, waitMs }) {
      let current: Snapshot
      try {
        current = await refresh()
      } catch (error) {
        if (last === undefined) {
          log('c2.home_unavailable', { error: String(error) })
          return { status: 503, body: { ok: false, code: 'home_unavailable' } }
        }
        return { status: 200, body: full(last, false) }
      }
      if (after === undefined || current.revision !== after)
        return { status: 200, body: full(current, true) }

      const wait = Math.min(waitMs ?? LONG_POLL_MAX_MS, LONG_POLL_MAX_MS)
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, wait)
          waiters.add(done)
        })
      }
      const latest = last ?? current
      if (latest.revision === after)
        return { status: 200, body: { ok: true, unchanged: true, revision: after } }
      // Waiters wake only from a successful read, so a changed `last` is current.
      return { status: 200, body: full(latest, true) }
    },

    async act(raw) {
      const invalid = validateRequest(raw)
      if (invalid !== null)
        return { status: 400, body: { ok: false, code: 'invalid_request', reason: invalid } }
      const request = raw as ActionRequest
      let response: ActionResponse
      try {
        response = await controller.act(request)
      } catch (error) {
        // An exception escaping act may follow a delivery: indeterminate, never resent.
        log('c2.act.failed', { requestId: request.requestId, error: String(error) })
        response = {
          ok: false,
          outcome: 'unknown_outcome',
          requestId: request.requestId,
          replayed: false,
          reason: 'controller_error',
        }
      }
      log('c2.act', { requestId: request.requestId, kind: request.kind, outcome: response.outcome })
      if (actedLineDue(request, response)) void sendActedLine(request, response)
      void refresh().catch(() => undefined)
      return {
        status: response.outcome === 'not_submitted' ? 503 : 200,
        body: toWireResponse(response),
      }
    },

    async reconcile(requestId, sessionRef, generation) {
      try {
        return {
          status: 200,
          body: toWireResponse(await controller.reconcile(requestId, sessionRef, generation)),
        }
      } catch (error) {
        log('c2.reconcile.failed', { requestId, error: String(error) })
        return { status: 503, body: { ok: false, code: 'home_unavailable' } }
      }
    },

    async artifact(id) {
      try {
        return serveArtifact(id, await controller.read(), roots)
      } catch (error) {
        log('c2.artifact.failed', { error: String(error) })
        return Response.json({ ok: false, code: 'home_unavailable' }, { status: 503 })
      }
    },

    stop() {
      clearInterval(poll)
      stopController()
      for (const wake of waiters) wake()
    },
  }
}

const ACTED_KINDS: ReadonlySet<string> = new Set(['reply', 'choose', 'compose'])

function actedLineDue(request: ActionRequest, response: ActionResponse): boolean {
  return (
    response.ok &&
    !response.replayed &&
    ACTED_KINDS.has(request.kind) &&
    (response.outcome === 'sent' || response.outcome === 'resolved') &&
    response.receipt?.runId !== undefined
  )
}

const services = new WeakMap<AcpC2Config, C2Service>()

/** One always-on service per instance config; created on server construction. */
export function ensureC2Service(deps: {
  c2?: AcpC2Config | undefined
  hrcClient?: AcpHrcClient | undefined
}): C2Service | undefined {
  if (deps.c2 === undefined || deps.hrcClient === undefined) return undefined
  let service = services.get(deps.c2)
  if (service === undefined) {
    service = createC2Service(deps.c2, deps.hrcClient)
    services.set(deps.c2, service)
  }
  return service
}

export function stopC2Service(deps: { c2?: AcpC2Config | undefined }): void {
  if (deps.c2 === undefined) return
  services.get(deps.c2)?.stop()
  services.delete(deps.c2)
}

/** Production config: the default Vesta seat unless this instance names another. */
export function c2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AcpC2Config {
  const vestaSeat = env['ACP_C2_VESTA_SEAT']?.trim()
  return { vestaSeat: vestaSeat !== undefined && vestaSeat !== '' ? vestaSeat : PRODUCTION_VESTA }
}
