import { type CreateClientOptions, type WorkClient, createClient } from '@wrkq/client'
import { type WrkqStoreAdapter, createWrkqStoreAdapter } from 'wrkq-lib'

import type { AcpWrkfWorkflowPort } from './port.js'

export interface WrkfLifecycleOptions {
  command?: string | undefined
  dbPath: string
  clientInfo: { name: string; version: string }
  wrkfDisabled?: boolean | undefined
  /**
   * Test seam: override the client factory (bypasses spawning a real binary).
   * Defaults to `@wrkq/client`'s `createClient`, which runs the `rpc.initialize`
   * handshake (autoInitialize) and throws on failure — that is what makes
   * startup fail-closed.
   */
  _createClient?: ((opts: CreateClientOptions) => Promise<WorkClient>) | undefined
}

export interface WrkfLifecycle {
  wrkf: AcpWrkfWorkflowPort | undefined
  /**
   * The four acp-core store ports (task/evidence/role/transition), derived from
   * the SAME shared `WorkClient` as `wrkf` above (T-04784, daedalus single-client
   * constraint). `undefined` when wrkf is disabled.
   */
  store: WrkqStoreAdapter | undefined
  /** Shared @wrkq/client instance backing wrkf + wrkq store ports. */
  client: WorkClient | undefined
  close(): Promise<void>
}

export async function createWrkfClientLifecycle(
  opts: WrkfLifecycleOptions
): Promise<WrkfLifecycle> {
  if (opts.wrkfDisabled) {
    return {
      wrkf: undefined,
      store: undefined,
      client: undefined,
      async close(): Promise<void> {},
    }
  }

  const factory = opts._createClient ?? createClient
  // autoInitialize runs `rpc.initialize` before resolving; a failed handshake
  // rejects here and propagates (fail-closed) — we never return a half-built port.
  const client = await factory({
    command: opts.command ?? process.env['WRKF_BIN'] ?? 'wrkf',
    dbPath: opts.dbPath,
    clientInfo: opts.clientInfo,
    autoInitialize: true,
  })

  let closed = false
  return {
    wrkf: createWrkfPortAdapter(client),
    // Both the wrkf workflow port and the wrkq store adapter are derived from
    // this one client — the Phase-1 lifecycle owns the single shared WorkClient.
    store: createWrkqStoreAdapter(client),
    client,
    async close(): Promise<void> {
      if (closed) {
        return
      }
      closed = true
      await closeOrKill(client)
    },
  }
}

/**
 * Adapt the namespaced `@wrkq/client` (`client.wrkf.*` / `client.wrkq.*`) onto
 * the flat-root `AcpWrkfWorkflowPort` shape consumed across acp-server. The port
 * stays unchanged (lowest blast radius); this thin shim maps each method 1:1.
 *
 * Forwarding goes through `fwd`, which erases the (looser) port param type onto
 * the typed facade param. The single cast lives in the helper so the mapping
 * table below stays declarative.
 */
function createWrkfPortAdapter(client: WorkClient): AcpWrkfWorkflowPort {
  // `fwd` derefs the facade method lazily (at call time, not construction) and
  // erases the port's looser param type onto the typed facade param. Lazy deref
  // mirrors the old pure-cast adapter and keeps the shim robust against partial
  // client doubles in tests. The single cast lives here so the table stays
  // declarative.
  const fwd =
    <P, R>(get: (c: WorkClient) => (p: P) => Promise<R>) =>
    (p: unknown): Promise<unknown> =>
      get(client)(p as P)

  return {
    workflow: {
      validate: fwd((c) => c.wrkf.workflow.validate),
      show: fwd((c) => c.wrkf.workflow.show),
      list: fwd((c) => c.wrkf.workflow.list),
      diff: fwd((c) => c.wrkf.workflow.diff),
      install: fwd((c) => c.wrkf.workflow.install),
    },
    task: {
      attach: fwd((c) => c.wrkq.workflow.attach),
      // `wrkq.workflow.inspect` wraps the instance record under `{ instance }`,
      // but the port contract (and every consumer — projectFlatWrkfInspect,
      // existingInstanceFrom, the effect reconciler) expects the FLAT instance
      // record the old `wrkf.task.inspect` returned. The wrapped `.instance`
      // carries exactly those flat keys, so unwrap it to keep the contract stable.
      inspect: (params: { task: string }): Promise<unknown> => unwrapInspect(client, params),
      timeline: fwd((c) => c.wrkq.workflow.timeline),
      refresh: fwd((c) => c.wrkq.workflow.refresh),
      // T-04764: no typed facade for `wrkf.task.syncMeta` yet — use the escape
      // hatch. Swap to `client.wrkf.task.syncMeta` once T-04764 adds the facade.
      syncMeta: (params: { task: string }): Promise<unknown> =>
        client.call('wrkf.task.syncMeta', params),
    },
    next: fwd((c) => c.wrkf.instance.next),
    evidence: {
      add: fwd((c) => c.wrkf.evidence.add),
      list: fwd((c) => c.wrkf.evidence.list),
      show: fwd((c) => c.wrkf.evidence.show),
      suggest: fwd((c) => c.wrkf.evidence.suggest),
    },
    obligation: {
      list: fwd((c) => c.wrkf.obligation.list),
      show: fwd((c) => c.wrkf.obligation.show),
      satisfy: fwd((c) => c.wrkf.obligation.satisfy),
      waive: fwd((c) => c.wrkf.obligation.waive),
      cancel: fwd((c) => c.wrkf.obligation.cancel),
    },
    transition: {
      apply: fwd((c) => c.wrkf.transition.apply),
    },
    run: {
      start: fwd((c) => c.wrkf.run.start),
      bindExternal: fwd((c) => c.wrkf.run.bindExternal),
      finish: fwd((c) => c.wrkf.run.finish),
      fail: fwd((c) => c.wrkf.run.fail),
      show: fwd((c) => c.wrkf.run.show),
      list: fwd((c) => c.wrkf.run.list),
    },
    effect: {
      list: fwd((c) => c.wrkf.effect.list),
      show: fwd((c) => c.wrkf.effect.show),
      claim: fwd((c) => c.wrkf.effect.claim),
      ack: fwd((c) => c.wrkf.effect.ack),
      fail: fwd((c) => c.wrkf.effect.fail),
      retry: fwd((c) => c.wrkf.effect.retry),
      deliver: fwd((c) => c.wrkf.effect.deliver),
    },
  }
}

/**
 * Call `wrkq.workflow.inspect` and unwrap its `{ instance }` envelope down to the
 * flat instance record (the shape the port contract promises). If the result is
 * not the expected wrapper, return it unchanged (defensive).
 */
async function unwrapInspect(client: WorkClient, params: { task: string }): Promise<unknown> {
  const result = await client.wrkq.workflow.inspect(params)
  if (typeof result === 'object' && result !== null && 'instance' in result) {
    const instance = (result as { instance?: unknown }).instance
    if (typeof instance === 'object' && instance !== null) {
      return instance
    }
  }
  return result
}

async function closeOrKill(client: Pick<WorkClient, 'close' | 'kill'>): Promise<void> {
  if (typeof client.close === 'function') {
    await client.close()
    return
  }

  if (typeof client.kill === 'function') {
    client.kill()
  }
}
