/**
 * Production-wire stack for the mobile timeline ordering E2E (T-07724).
 *
 * Every seam here is the real one:
 *
 *  - HRC is a real `hrc-server` daemon on an isolated runtime/state root, and
 *    its lifecycle ledger is written through the real
 *    `HrcLifecycleEventRepository` (history) and the daemon's own ingest
 *    listener (`POST /v1/ingest`, live fan-out through `followSubscribers`).
 *  - wrkq is a real store (`wrkqadm init`) driven by the real `wrkf` RPC
 *    process through `@wrkq/client`; envelopes are minted with `wrkq.room.say`.
 *  - ACP is the production `acp-server` CLI, spawned as its own process with
 *    isolated databases, serving over real `Bun.serve` HTTP and WebSocket.
 *  - Bearer auth is the production gate: a pairing code minted on the loopback
 *    admin route, redeemed for a real token, with enforcement armed. Loopback
 *    peers bypass bearer by contract, so the suite binds a second, non-loopback
 *    listener and drives every timeline request through it.
 *
 * There are no hand-written producer or projector doubles.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { type WorkClient, createClient } from '@wrkq/client'
import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'
import { type HrcLifecycleEventInput, openHrcDatabase } from 'hrc-store-sqlite'

import { type ScratchHrcDaemon, createScratchHrcDaemon } from './scratch-hrc.js'

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '')
const ACP_SERVER_ENTRY = join(REPO_ROOT, 'packages/acp-server/src/cli.ts')
const EMPTY_HOOK_CATALOG = join(
  REPO_ROOT,
  'packages/acp-server/test/fixtures/empty-wrkf-hook-catalog.json'
)

export type TimelineStack = {
  root: string
  hrc: ScratchHrcDaemon
  wrkqDbPath: string
  /**
   * Real `wrkf` RPC clients, pooled by caller principal.
   *
   * wrkq records room membership under the CALLER's connection principal, and
   * `envelope.memberPage` joins membership on the principal derived from the
   * member handle. A single shared connection would therefore stamp every
   * membership with one principal and make the member page silently empty —
   * observed against the real server before this fixture was written.
   */
  wrkqAs(principalRef: string): Promise<WorkClient>
  /** Read-only observer connection (`agent:acp-timeline-e2e`). */
  wrkq: WorkClient
  port: number
  /** `http://127.0.0.1:<port>` — operator/admin surface (loopback-gated routes). */
  loopbackBase: string
  /**
   * `http://<non-loopback>:<port>` when this host has a non-loopback IPv4
   * address. Timeline traffic uses it so the bearer gate is actually enforced.
   */
  remoteBase: string | undefined
  /** The base every timeline request should use. */
  apiBase: string
  bearerToken: string
  /** True when `apiBase` is non-loopback, i.e. the bearer is load-bearing. */
  bearerEnforcedOnApiBase: boolean
  serverOutput(): string
  close(): Promise<void>
}

export function firstNonLoopbackIpv4(): string | undefined {
  const candidates: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4') continue
      candidates.push(address.address)
    }
  }
  // Prefer a tailnet address (100.64.0.0/10) — it is the most stable interface
  // on the fleet — then fall back to whatever non-loopback IPv4 exists.
  return (
    candidates.find((address) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) ??
    candidates[0]
  )
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/mobile/health`)
      if (response.ok) {
        await response.body?.cancel()
        return
      }
      lastError = `status ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(200)
  }
  throw new Error(`acp-server did not become healthy on ${base}: ${lastError}`)
}

async function pickFreePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error('failed to reserve an ephemeral port for acp-server')
  return port
}

export async function createTimelineStack(): Promise<TimelineStack> {
  const root = mkdtempSync(join(tmpdir(), 'acp-timeline-e2e-'))
  const acpDir = join(root, 'acp')
  mkdirSync(acpDir, { recursive: true })

  const wrkqDbPath = join(root, 'wrkq.db')
  const initialized = Bun.spawnSync(['wrkqadm', '--db', wrkqDbPath, 'init'], { cwd: root })
  if (initialized.exitCode !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`wrkqadm init failed: ${initialized.stderr.toString()}`)
  }

  const hrc = await createScratchHrcDaemon('acp-timeline-e2e-hrc-')
  const teardown: Array<() => void | Promise<void>> = [() => hrc.close()]

  const finish = async (error: unknown): Promise<never> => {
    for (const step of teardown.reverse()) {
      try {
        await step()
      } catch {
        // Teardown of a failed startup is best-effort.
      }
    }
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  const wrkqClients = new Map<string, Promise<WorkClient>>()
  const wrkqAs = (principalRef: string): Promise<WorkClient> => {
    const existing = wrkqClients.get(principalRef)
    if (existing !== undefined) return existing
    const created = createClient({
      command: process.env['WRKF_BIN'] ?? 'wrkf',
      dbLocator: wrkqDbPath,
      clientInfo: { name: 'acp-timeline-e2e', version: '0.1.0' },
      hookCatalogPath: EMPTY_HOOK_CATALOG,
      principalRef,
      autoInitialize: true,
    })
    wrkqClients.set(principalRef, created)
    return created
  }
  teardown.push(async () => {
    const settled = await Promise.allSettled(wrkqClients.values())
    for (const result of settled) {
      if (result.status === 'fulfilled') await result.value.close?.()
    }
    wrkqClients.clear()
  })

  let wrkq: WorkClient
  try {
    wrkq = await wrkqAs('agent:acp-timeline-e2e')
  } catch (error) {
    return finish(error)
  }

  const port = await pickFreePort()
  const remoteHost = firstNonLoopbackIpv4()
  const hosts = remoteHost === undefined ? '127.0.0.1' : `127.0.0.1,${remoteHost}`

  const child = Bun.spawn(
    [
      process.execPath,
      ACP_SERVER_ENTRY,
      '--wrkq-db',
      wrkqDbPath,
      '--coord-db-path',
      join(acpDir, 'coordination.db'),
      '--interface-db-path',
      join(acpDir, 'interface.db'),
      '--state-db-path',
      join(acpDir, 'state.db'),
      '--admin-db-path',
      join(acpDir, 'admin.db'),
      '--jobs-db-path',
      join(acpDir, 'jobs.db'),
      '--conversation-db-path',
      join(acpDir, 'conversation.db'),
      '--agent-assets-dir',
      join(acpDir, 'agent-assets'),
      '--host',
      hosts,
      '--port',
      String(port),
      '--actor',
      'acp-timeline-e2e',
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HRC_RUNTIME_DIR: hrc.runtimeRoot,
        HRC_STATE_DIR: hrc.stateRoot,
        ACP_REAL_HRC_LAUNCHER: '1',
        ACP_MOBILE_AUTH_PATH: join(acpDir, 'mobile-auth.json'),
        ACP_RUNTIME_DIR: join(acpDir, 'run'),
        ACP_CAP_SOCKET_PATH: join(acpDir, 'cap.sock'),
        ACP_CAP_CATALOG_STATE_DIR: join(acpDir, 'cap-catalog'),
        WRKF_HOOK_CATALOG: EMPTY_HOOK_CATALOG,
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  const output: string[] = []
  const decoder = new TextDecoder()
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) output.push(decoder.decode(chunk))
  }
  void drain(child.stdout).catch(() => undefined)
  void drain(child.stderr).catch(() => undefined)
  teardown.push(async () => {
    child.kill()
    await child.exited
  })

  const loopbackBase = `http://127.0.0.1:${port}`
  const remoteBase = remoteHost === undefined ? undefined : `http://${remoteHost}:${port}`

  try {
    await waitForHealth(loopbackBase, 45_000)
    if (remoteBase !== undefined) await waitForHealth(remoteBase, 15_000)
  } catch (error) {
    return finish(new Error(`${String(error)}\n--- acp-server output ---\n${output.join('')}`))
  }

  // Production bearer issuance: mint on the loopback admin route, redeem on the
  // route that actually issues tokens, then arm enforcement.
  let bearerToken: string
  try {
    const minted = (await (
      await fetch(`${loopbackBase}/v1/mobile/auth/pairing-code`, { method: 'POST' })
    ).json()) as { ok?: boolean; code?: string }
    if (minted.ok !== true || typeof minted.code !== 'string') {
      throw new Error(`pairing-code mint failed: ${JSON.stringify(minted)}`)
    }
    const paired = (await (
      await fetch(`${remoteBase ?? loopbackBase}/v1/mobile/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: minted.code, deviceName: 'acp-timeline-e2e' }),
      })
    ).json()) as { token?: string }
    if (typeof paired.token !== 'string' || paired.token.length === 0) {
      throw new Error(`pairing redemption returned no token: ${JSON.stringify(paired)}`)
    }
    bearerToken = paired.token
    const armed = (await (
      await fetch(`${loopbackBase}/v1/mobile/auth/enforce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enforce: true }),
      })
    ).json()) as { ok?: boolean; enforce?: boolean }
    if (armed.ok !== true || armed.enforce !== true) {
      throw new Error(`arming mobile bearer enforcement failed: ${JSON.stringify(armed)}`)
    }
  } catch (error) {
    return finish(new Error(`${String(error)}\n--- acp-server output ---\n${output.join('')}`))
  }

  const apiBase = remoteBase ?? loopbackBase
  let closed = false
  return {
    root,
    hrc,
    wrkqDbPath,
    wrkqAs,
    wrkq,
    port,
    loopbackBase,
    remoteBase,
    apiBase,
    bearerToken,
    bearerEnforcedOnApiBase: remoteBase !== undefined,
    serverOutput: () => output.join(''),
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const step of teardown.reverse()) {
        try {
          await step()
        } catch {
          // Best-effort teardown; the scratch root is removed regardless.
        }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// ── HTTP / WebSocket helpers ────────────────────────────────────────────────

export function authorizedHeaders(stack: TimelineStack): Record<string, string> {
  return { authorization: `Bearer ${stack.bearerToken}` }
}

export type HistoryQuery = {
  sessionRef: string
  hostSessionId: string
  generation: number
  limit?: number | undefined
  cursor?: string | undefined
  extra?: Record<string, string> | undefined
}

export function historyUrl(stack: TimelineStack, query: HistoryQuery): string {
  const url = new URL(`${stack.apiBase}/v1/mobile/history`)
  url.searchParams.set('sessionRef', query.sessionRef)
  url.searchParams.set('hostSessionId', query.hostSessionId)
  url.searchParams.set('generation', String(query.generation))
  if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
  if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor)
  for (const [key, value] of Object.entries(query.extra ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

export type MobileTimelineAtomWire = {
  atomId: string
  projectionEpoch: string
  timelineOrdinal: string
  logicalFrameId: string
  operation: 'append' | 'replace'
  sourceKind: 'hrc' | 'wrkq'
  sourceSeq: number
  sourceTs: string
  prefixState: string
  payload: Record<string, unknown>
}

export type HistoryPageWire = {
  projectionEpoch: string
  atoms: MobileTimelineAtomWire[]
  olderCursor: string | null
  hasMoreBefore: boolean
  snapshotHighWater: { hrcSeq: number; messageSeq: number }
  resetReason?: string
}

export type HistoryResponse = {
  status: number
  bytes: number
  body: HistoryPageWire & { ok?: boolean; code?: string; message?: string }
}

export async function readHistory(
  stack: TimelineStack,
  query: HistoryQuery
): Promise<HistoryResponse> {
  const response = await fetch(historyUrl(stack, query), { headers: authorizedHeaders(stack) })
  const text = await response.text()
  return {
    status: response.status,
    bytes: Buffer.byteLength(text, 'utf8'),
    body: JSON.parse(text) as HistoryResponse['body'],
  }
}

// ── HRC seeding ─────────────────────────────────────────────────────────────

export function insertHrcSession(stack: TimelineStack, record: HrcSessionRecord): void {
  const db = openHrcDatabase(join(stack.hrc.stateRoot, 'state.sqlite'))
  try {
    db.sessions.insert(record)
  } finally {
    db.close()
  }
}

/**
 * Force a producer ledger incarnation change, the way a rebuilt/replaced ledger
 * presents to consumers. Both producers publish their incarnation from a
 * singleton metadata row; rewriting it is the observable replacement event.
 */
export function replaceHrcLedgerIncarnation(stack: TimelineStack): string {
  const db = openHrcDatabase(join(stack.hrc.stateRoot, 'state.sqlite'))
  try {
    const replacement = `replaced${Date.now().toString(16)}`
    db.sqlite
      .query('UPDATE hrc_event_ledger_metadata SET ledger_incarnation_id = ? WHERE id = 1')
      .run(replacement)
    return db.hrcEvents.ledgerIncarnationId()
  } finally {
    db.close()
  }
}

export function replaceCollaborationLedgerIncarnation(stack: TimelineStack): string {
  const db = new Database(stack.wrkqDbPath)
  try {
    const replacement = `replaced${Date.now().toString(16)}`
    db.query('UPDATE collaboration_ledger_meta SET incarnation = ? WHERE singleton = 1').run(
      replacement
    )
    return replacement
  } finally {
    db.close()
  }
}

/**
 * Append history through the real lifecycle-event repository — the same append
 * the daemon itself calls. Written on a second connection to the daemon's own
 * SQLite file, so the daemon reads these rows back through its ordinary
 * `tailEvents` / replay queries.
 */
export function appendHrcHistory(
  stack: TimelineStack,
  events: readonly HrcLifecycleEventInput[]
): HrcLifecycleEvent[] {
  const db = openHrcDatabase(join(stack.hrc.stateRoot, 'state.sqlite'))
  try {
    const appended: HrcLifecycleEvent[] = []
    for (const event of events) appended.push(db.hrcEvents.append(event))
    return appended
  } finally {
    db.close()
  }
}

export type LiveHrcIngest = {
  post(events: readonly HrcLifecycleEventInput[]): Promise<number>
}

/**
 * Live lifecycle arrivals through the daemon's real ingest listener. This is the
 * only path that reaches `followSubscribers`, so it is the only way to make the
 * production bounded-event stream deliver an arrival to an already-open mobile
 * timeline WebSocket.
 */
export function createLiveHrcIngest(stack: TimelineStack, sourceRef: string): LiveHrcIngest {
  const socketPath = join(stack.hrc.runtimeRoot, 'ingest', 'events.sock')
  let originSeq = 0
  return {
    async post(events): Promise<number> {
      let posted = 0
      for (let index = 0; index < events.length; index += 50) {
        const batch = events.slice(index, index + 50).map((event) => {
          originSeq += 1
          return {
            originSeq,
            event: {
              ...event,
              hrcSeq: 0,
              streamSeq: 0,
              replayed: event.replayed ?? false,
              payload: event.payload ?? {},
            },
          }
        })
        const response = await fetch('http://ingest.invalid/v1/ingest', {
          method: 'POST',
          unix: socketPath,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, sourceRef, feed: 'hrc_events', events: batch }),
        })
        const body = (await response.json()) as { ok?: boolean; message?: string }
        if (!response.ok || body.ok !== true) {
          throw new Error(`hrc ingest rejected batch: ${response.status} ${JSON.stringify(body)}`)
        }
        posted += batch.length
      }
      return posted
    },
  }
}

// ── wrkq seeding ────────────────────────────────────────────────────────────

export type SeededEnvelope = {
  messageId: string
  messageSeq: number
  body: string
  createdAt: string
}

/**
 * Mint collaboration envelopes through the real `wrkq.room.say` RPC, speaking as
 * `speakerHandle` under its own connection principal. Identities are returned
 * exactly as wrkq assigned them, so the oracle is grounded on wrkq's ledger and
 * not on this call's input.
 */
export async function seedCollaborationEnvelopes(
  stack: TimelineStack,
  input: {
    speakerHandle: string
    speakerPrincipalRef: string
    addresseeHandle: string
    bodies: readonly string[]
  }
): Promise<SeededEnvelope[]> {
  const client = await stack.wrkqAs(input.speakerPrincipalRef)
  const seeded: SeededEnvelope[] = []
  for (const body of input.bodies) {
    const receipt = await client.wrkq.room.say({
      ref: input.addresseeHandle,
      to: [input.addresseeHandle],
      body,
      fyi: true,
      scopeRef: input.speakerHandle,
    })
    for (const envelope of receipt.envelopes) {
      seeded.push({
        messageId: envelope.id,
        messageSeq: envelope.messageSeq,
        body: envelope.body,
        createdAt: envelope.createdAt,
      })
    }
  }
  return seeded
}

export type CollaborationLedgerView = {
  ledgerIncarnation: string
  headMessageSeq: number
  envelopes: SeededEnvelope[]
}

/**
 * Read the member's collaboration ledger back from the real producer, paging to
 * exhaustion. This is the canonical wrkq-side identity set the oracle uses.
 */
export async function readCollaborationLedger(
  stack: TimelineStack,
  memberHandle: string
): Promise<CollaborationLedgerView> {
  const envelopes: SeededEnvelope[] = []
  let before = Number.MAX_SAFE_INTEGER
  let ledgerIncarnation = ''
  let headMessageSeq = 0
  for (;;) {
    const page = await stack.wrkq.wrkq.envelope.memberPage({
      memberRef: memberHandle,
      beforeMessageSeq: before,
      limit: 500,
      principalRef: 'agent:acp-timeline-e2e',
      scopeRef: memberHandle,
    })
    ledgerIncarnation = page.ledgerIncarnation
    headMessageSeq = page.headMessageSeq
    envelopes.unshift(
      ...page.items.map((item) => ({
        messageId: item.id,
        messageSeq: item.messageSeq,
        body: item.body,
        createdAt: item.createdAt,
      }))
    )
    if (!page.hasMoreBefore || page.items.length === 0) break
    before = page.items[0]?.messageSeq ?? before
  }
  return { ledgerIncarnation, headMessageSeq, envelopes }
}
