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
  type ActionKind,
  type ActionRequest,
  type ActionResponse,
  Controller,
  PRODUCTION_VESTA,
  WIRE_VERSION,
  online,
  toWire,
  validateRequest,
  wireResponse,
} from '@praesidium/c2-core'

import type { WorkClient } from '@wrkq/client'
import { writeLogLine } from 'acp-core'

import type { AcpHrcClient } from '../deps.js'
import { mintArtifactId, serveArtifact } from './artifacts.js'
import { type AcpC2Config, C2_DEFAULTS, defaultArtifactRoots } from './config.js'
import { type C2HrcHost, createC2HrcHost } from './hrc-adapter.js'

export const C2_CONTROLLER_PRINCIPAL = 'system:c2-controller'
export const C2_PHONE_PRINCIPAL = 'agent:lance'
export const C2_ACTION_KINDS = [
  'answer',
  'compose',
  'jump',
  'delegate',
  'rotate',
  'elucidate',
  'release',
  'snooze',
] as const satisfies readonly ActionKind[]
// The advertised `capabilities.actions` must name every kind c2-core accepts: the
// phone gates Send on it, and a kind missing here silently disables that action
// (card contract §12.3). This fails typecheck at the pin bump instead of in the field.
type MissingActionKinds = Exclude<ActionKind, (typeof C2_ACTION_KINDS)[number]>
const allActionKindsAdvertised: [MissingActionKinds] extends [never] ? true : never = true
void allActionKindsAdvertised
export const LONG_POLL_MAX_MS = 25_000
/** A GET older than this kicks a background refresh (never waited on). */
export const SNAPSHOT_FRESH_MS = 5_000
/** Cold start only: how long a GET waits for the first snapshot before home_unavailable. */
export const COLD_SNAPSHOT_WAIT_MS = 10_000

type WireBody = ReturnType<typeof toWire>
type Snapshot = { body: WireBody; revision: string; asOf: string; okAt: number; node: string }
export type C2HttpResult = { status: number; body: unknown }

export type C2Service = {
  snapshot(query: {
    after?: string | undefined
    waitMs?: number | undefined
  }): Promise<C2HttpResult>
  act(raw: unknown): Promise<C2HttpResult>
  reconcile(requestId: string, sessionRef: string): Promise<C2HttpResult>
  artifact(id: string): Promise<Response>
  stop(): void
}

function log(event: string, data: Record<string, unknown>): void {
  writeLogLine({ level: 'info', component: 'acp-c2', event, data })
}

/**
 * T-12233 §4: whether a pending or acknowledged wrkq handoff for the agent@project
 * scope (`agent:<a>:project:<p>`) was created at/after `sinceIso`. wrkq lists
 * newest first and stamps whole seconds, so a handoff in the attention's own
 * second counts. Null without a wrkq client.
 */
export function wrkqHandoffSince(workClient: WorkClient | undefined) {
  if (workClient === undefined) return undefined
  return async (scopeRef: string, sinceIso: string): Promise<boolean | null> => {
    const since = Math.floor(Date.parse(sinceIso) / 1000) * 1000
    if (Number.isNaN(since)) return null
    const page = await workClient.wrkq.handoff.listView({ scopeRef, status: 'all', limit: 5 })
    return page.items.some((h) => Date.parse(h.created_at) >= since)
  }
}

export function createC2Service(
  config: AcpC2Config,
  hrcClient: AcpHrcClient,
  workClient?: WorkClient | undefined
): C2Service {
  const pollMs = config.pollMs ?? C2_DEFAULTS.pollMs
  const roots = config.artifactRoots ?? defaultArtifactRoots()
  const host: C2HrcHost = createC2HrcHost({
    client: hrcClient,
    vestaSeat: config.vestaSeat,
    principal: C2_CONTROLLER_PRINCIPAL,
    node: config.node,
    sweepMs: config.sweepMs ?? C2_DEFAULTS.sweepMs,
    ownsUnscoped: config.vestaSeat === PRODUCTION_VESTA,
    literalInputTimeoutMs: config.literalInputTimeoutMs ?? C2_DEFAULTS.literalInputTimeoutMs,
    handoffSince: wrkqHandoffSince(workClient),
    log: (line) => log('c2.host', { line }),
  })
  const controller = new Controller(host, {
    vestaSeat: config.vestaSeat,
    principal: C2_CONTROLLER_PRINCIPAL,
    actor: C2_PHONE_PRINCIPAL,
    classify: true,
    ...(config.node !== undefined ? { node: config.node } : {}),
    ...(config.settleMs !== undefined ? { settleMs: config.settleMs } : {}),
    ...(config.reviewAfterMs !== undefined ? { reviewAfterMs: config.reviewAfterMs } : {}),
    ...(config.graceMs !== undefined ? { graceMs: config.graceMs } : {}),
  })

  // The warm snapshot (T-12227). The poll timer refreshes it in the background;
  // a phone GET reads it and never waits on an HRC observation once it exists.
  let last: Snapshot | undefined
  /** The last background refresh failed: serve `last` as stale until one succeeds. */
  let unreachable = false
  const waiters = new Set<() => void>()
  let refreshing: Promise<Snapshot> | null = null

  async function readSnapshot(): Promise<Snapshot> {
    const [view, node] = await Promise.all([controller.read(), host.node()])
    const body = toWire(view, mintArtifactId)
    const revision = Bun.hash(JSON.stringify(body)).toString(36)
    const snapshot: Snapshot = { body, revision, asOf: view.asOf, okAt: Date.now(), node }
    const changed = last?.revision !== revision
    last = snapshot
    unreachable = false
    if (changed) {
      for (const wake of waiters) wake()
    }
    return snapshot
  }

  function refresh(): Promise<Snapshot> {
    if (refreshing === null) {
      refreshing = readSnapshot()
        .catch((error: unknown) => {
          unreachable = true
          throw error
        })
        .finally(() => {
          refreshing = null
        })
    }
    return refreshing
  }

  function refreshInBackground(): void {
    void refresh().catch(() => undefined)
  }

  /** The cached snapshot, or on a cold start the first read within its bound. */
  async function current(): Promise<{ snapshot: Snapshot; reachable: boolean } | undefined> {
    if (last !== undefined) {
      if (Date.now() - last.okAt > SNAPSHOT_FRESH_MS) refreshInBackground()
      return { snapshot: last, reachable: !unreachable }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), COLD_SNAPSHOT_WAIT_MS)
    })
    try {
      const first = await Promise.race([refresh(), bound])
      if (first !== undefined) return { snapshot: first, reachable: true }
      log('c2.home_unavailable', { error: `no snapshot within ${COLD_SNAPSHOT_WAIT_MS}ms` })
    } catch (error) {
      log('c2.home_unavailable', { error: String(error) })
    } finally {
      clearTimeout(timer)
    }
    return undefined
  }

  function full(snapshot: Snapshot, reachable: boolean) {
    const ageMs = reachable ? 0 : Date.now() - snapshot.okAt
    return {
      ok: true as const,
      wire: WIRE_VERSION,
      revision: snapshot.revision,
      asOf: snapshot.asOf,
      home: { node: snapshot.node, reachable, ageMs, stale: !reachable },
      ...snapshot.body,
      capabilities: { actions: [...C2_ACTION_KINDS], artifacts: true, longPoll: true },
    }
  }

  function toWireResponse(response: ActionResponse) {
    return wireResponse(response, mintArtifactId)
  }

  /**
   * The acted line (card contract §6), as c2-core words it (`response.acted`): after a
   * delivered answer or compose, one best-effort line to the live configured Vesta
   * seat through the fenced literal input. Never retried or queued; skipped when
   * Vesta is offline; its failure never changes the action's outcome.
   */
  async function sendActedLine(requestId: string, line: string): Promise<void> {
    try {
      const view = await controller.read()
      const vesta = view.seatRows.find((row) => row.scopeRef === config.vestaSeat)
      if (vesta === undefined || !online(vesta)) {
        log('c2.acted.skipped', { requestId, vestaOnline: false })
        return
      }
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
        requestId,
        ok: !('code' in sent),
        ...('code' in sent ? { code: sent.code } : {}),
      })
    } catch (error) {
      log('c2.acted.failed', { requestId, error: String(error) })
    }
  }

  const stopController = controller.start()
  const poll = setInterval(refreshInBackground, pollMs)
  void refresh().catch((error) => log('c2.observe.failed', { error: String(error) }))

  return {
    async snapshot({ after, waitMs }) {
      const read = await current()
      if (read === undefined) return { status: 503, body: { ok: false, code: 'home_unavailable' } }
      const { snapshot, reachable } = read
      if (after === undefined || snapshot.revision !== after)
        return { status: 200, body: full(snapshot, reachable) }

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
      const latest = last ?? snapshot
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
      // c2-core decides the line and when one is due; ACP sends it once, never for a replay.
      if (!response.replayed && response.acted !== undefined)
        void sendActedLine(request.requestId, response.acted)
      refreshInBackground()
      return {
        status: response.outcome === 'not_submitted' ? 503 : 200,
        body: toWireResponse(response),
      }
    },

    async reconcile(requestId, sessionRef) {
      try {
        return {
          status: 200,
          body: toWireResponse(await controller.reconcile(requestId, sessionRef)),
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

const services = new WeakMap<AcpC2Config, C2Service>()

/** One always-on service per instance config; created on server construction. */
export function ensureC2Service(deps: {
  c2?: AcpC2Config | undefined
  hrcClient?: AcpHrcClient | undefined
  workClient?: WorkClient | undefined
}): C2Service | undefined {
  if (deps.c2 === undefined || deps.hrcClient === undefined) return undefined
  let service = services.get(deps.c2)
  if (service === undefined) {
    service = createC2Service(deps.c2, deps.hrcClient, deps.workClient)
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
