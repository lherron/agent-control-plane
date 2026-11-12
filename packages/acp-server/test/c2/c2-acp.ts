/**
 * Ephemeral ACP for the C2 mobile wire (card contract rev 4.1 §12, T-12239): the
 * real router and listener handlers on a Bun.serve TCP port, a real hrc-sdk
 * `HrcClient` over the fake HRC unix socket, and a disposable fixture seat whose
 * `hrc.asks` record holds one open row.
 * Nothing here touches a real seat or a human card.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAcpListenerHandlers } from '../../src/acp-listener.js'
import type { AcpC2Config } from '../../src/c2/config.js'
import { type AcpHrcClient, type AcpServerDeps, resolveAcpServerDeps } from '../../src/deps.js'
import { AcpHrcSdkClient } from '../../src/hrc-client.js'
import type { MobileAuthStore } from '../../src/mobile-auth/store.js'

import { type WiredServerFixture, withWiredServer } from '../fixtures/wired-server.js'
import { type FakeAnnotation, type FakeHrc, type FakeSeat, startFakeHrc } from './fake-hrc.js'

export const NODE = 'max3'
export const VESTA = 'agent:vesta:project:c2:task:primary'
/** Inside Stella's owner-approved boundary (`:project:c2:task:c2fixture-`). */
export const SEAT = 'agent:smokey:project:c2:task:c2fixture-acp'
export const SEAT_REF = `${SEAT}/lane:main`
/** A non-production Vesta, as the 18471 fixture instance is configured. */
export const FIXTURE_VESTA = 'agent:clod:project:c2:task:c2fixture-vesta'
/** Stands in for a real human card: a seat outside every fixture scope, holding c2 rows. */
export const OUT_SEAT = 'agent:mable:project:human:task:primary'
/** Shaped like the max3 seat whose scope HRC retired with no home bound (session_home_pending). */
export const RETIRED_SEAT = 'agent:stella:project:arris:task:primary-quasar'
export const ATTENTION_AT = '2026-11-01T05:00:00.000Z'
export const ASK = 'Ship the disposable fixture?'
export const ANSWER_TEXT = `1. ${ASK} \u2014 Ship.`
export const SCOPE_ALLOW = ['^agent:smokey:project:c2:task:c2fixture-[a-z0-9-]+$']

export type C2Roots = { wrkqArtifacts: string; scratchC2: string; outside: string }

export type C2Acp = {
  base: string
  fake: FakeHrc
  wired: WiredServerFixture
  roots: C2Roots
  htmlPath: string
  /** The fixture seat's `hrc.asks` record. */
  record(): FakeAnnotation
  get(path: string, headers?: HeadersInit): Promise<Response>
  post(path: string, body: unknown, headers?: HeadersInit): Promise<Response>
  getJson<T = Record<string, unknown>>(path: string): Promise<{ status: number; body: T }>
  postJson<T = Record<string, unknown>>(
    path: string,
    body: unknown
  ): Promise<{ status: number; body: T }>
}

export type C2AcpOptions = {
  config?: Partial<AcpC2Config>
  mobileAuthStore?: MobileAuthStore
  /** Skip seeding the scope row on the Vesta seat (absent row allows nothing). */
  noScope?: boolean
  /** Stop HRC before ACP boots, so no snapshot was ever read. */
  hrcDownAtBoot?: boolean
  /** Serve the fixture Vesta (scope row and config there) instead of production's. */
  fixtureVesta?: boolean
  /** Shape HRC before ACP's first read (e.g. inject seat errors). */
  beforeBoot?: (fake: FakeHrc) => void
  /** The wrkq client ACP reads handoffs through (T-12233); absent means no handoff lookup. */
}

export function fixtureSeats(): FakeSeat[] {
  return [
    {
      scopeRef: FIXTURE_VESTA,
      hostSessionId: 'hsid-fixture-vesta',
      generation: 1,
      runtimeLive: true,
      runtimeId: 'rt-fixture-vesta',
      attention: null,
    },
    {
      scopeRef: RETIRED_SEAT,
      hostSessionId: 'hsid-retired',
      generation: 1,
      runtimeLive: false,
      runtimeId: 'rt-retired',
      attention: null,
    },
    {
      scopeRef: OUT_SEAT,
      hostSessionId: 'hsid-out-seat',
      generation: 4,
      runtimeLive: true,
      runtimeId: 'rt-out-seat',
      attention: null,
    },
    {
      scopeRef: VESTA,
      hostSessionId: 'hsid-vesta-fixture',
      generation: 3,
      runtimeLive: true,
      runtimeId: 'rt-vesta-fixture',
      attention: null,
    },
    {
      scopeRef: SEAT,
      hostSessionId: 'hsid-c2fixture-acp',
      generation: 2,
      runtimeLive: true,
      runtimeId: 'rt-c2fixture-acp',
      attention: {
        source: 'jev',
        state: 'blocking',
        kind: 'decision',
        at: ATTENTION_AT,
        excerpt: 'Ship the fixture?',
        text: 'The fixture builds clean.\n\n**Ship the fixture?**',
      },
    },
  ]
}

export function asksBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    questions: [
      {
        id: 'ship',
        ask: ASK,
        options: [{ label: 'Ship' }, { label: 'Hold', text: 'Hold until Monday' }],
        recommended: 'Ship',
        why: 'It is disposable.',
        task: 'T-12239',
        ...extra,
      },
    ],
  }
}

export function newRequestId(): string {
  return crypto.randomUUID()
}

export async function withC2Acp<T>(
  run: (acp: C2Acp) => Promise<T> | T,
  options: C2AcpOptions = {}
): Promise<T> {
  const tmp = realpathSync(mkdtempSync('/tmp/c2acp-'))
  const roots: C2Roots = {
    wrkqArtifacts: join(tmp, 'wrkq-artifacts'),
    scratchC2: join(tmp, 'scratch', 'c2'),
    outside: join(tmp, 'outside'),
  }
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })

  const htmlPath = join(roots.scratchC2, 'explain.html')
  writeFileSync(htmlPath, '<!doctype html><title>why</title><p>Because it is disposable.</p>')

  const fake = startFakeHrc(fixtureSeats())
  const vestaSeat = options.fixtureVesta === true ? FIXTURE_VESTA : VESTA
  if (options.noScope !== true) {
    fake.put({
      scopeRef: vestaSeat,
      subject: 'seat',
      kind: 'config',
      id: 'scope',
      body: { v: 1, allow: SCOPE_ALLOW },
      by: 'agent:lance',
    })
  }
  fake.put({
    scopeRef: SEAT,
    subject: 'seat',
    ns: 'hrc',
    kind: 'asks',
    id: 'open',
    body: asksBody(),
    by: 'agent:smokey',
  })
  fake.put({
    scopeRef: SEAT,
    subject: 'seat',
    kind: 'detail',
    id: 'ship',
    body: { v: 1, detailRef: htmlPath, at: ATTENTION_AT },
    by: 'agent:vesta',
  })
  // An open card on a seat no fixture scope allows, whose attention has moved on.
  fake.put({
    scopeRef: OUT_SEAT,
    generation: 4,
    kind: 'card',
    id: '2026-11-01T04:00:00.000Z',
    body: {
      v: 4,
      source: 'vesta',
      state: 'open',
      title: 'human',
      actions: [],
      createdAt: '2026-11-01T04:00:00.000Z',
    },
  })

  options.beforeBoot?.(fake)
  if (options.hrcDownAtBoot === true) await fake.stop()
  const hrcClient: AcpHrcClient = new AcpHrcSdkClient({
    socketPath: fake.socketPath,
    userAgent: 'acp-c2-reds',
  })
  const c2: AcpC2Config = {
    vestaSeat,
    node: NODE,
    artifactRoots: [roots.wrkqArtifacts, roots.scratchC2],
    pollMs: 50,
    literalInputTimeoutMs: 250,
    ...options.config,
  }
  const overrides: Partial<Omit<AcpServerDeps, 'wrkqStore' | 'coordStore'>> = {
    hrcClient,
    c2,
    ...(options.mobileAuthStore !== undefined ? { mobileAuthStore: options.mobileAuthStore } : {}),
  }

  try {
    return await withWiredServer(async (wired) => {
      const handlers = createAcpListenerHandlers({
        acpServer: wired.server,
        deps: resolveAcpServerDeps(wired.deps),
        handleCapRpc: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
      })
      const listener = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request, server) => handlers.fetch(request, server),
        websocket: handlers.websocket as never,
      })
      const base = `http://127.0.0.1:${listener.port}`
      const get = (path: string, headers?: HeadersInit) => fetch(`${base}${path}`, { headers })
      const post = (path: string, body: unknown, headers?: HeadersInit) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        })
      const acp: C2Acp = {
        base,
        fake,
        wired,
        roots,
        htmlPath,
        record() {
          const row = fake.find(SEAT, 'asks', 'open', null)
          if (row === undefined) throw new Error('fixture asks record missing')
          return row
        },
        get,
        post,
        async getJson<T>(path: string) {
          const response = await get(path)
          return { status: response.status, body: (await response.json()) as T }
        },
        async postJson<T>(path: string, body: unknown) {
          const response = await post(path, body)
          return { status: response.status, body: (await response.json()) as T }
        },
      }
      // Rev 5: the controller's first pass writes the fixture row's c2.item. Let it land so a test
      // starts from a quiescent seat (its "writes nothing" and long-poll checks measure from here).
      if (options.hrcDownAtBoot !== true && options.noScope !== true) await itemWritten(fake)
      try {
        return await run(acp)
      } finally {
        listener.stop(true)
        // Phase G gives the server a close() for the controller loop.
        await (wired.server as { close?: () => Promise<void> }).close?.()
      }
    }, overrides)
  } finally {
    await fake.stop()
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- wire shapes the reds read (card contract rev 4.1 §12.3–§12.4) ----

export type EntryKey = { sessionRef: string; subject: 'seat'; ns: string; kind: string; id: string }
export type WireAction = { id: string; kind: string; label: string; text?: string }
export type WireRow = {
  id: string
  displayId: string
  ask: string
  options: Array<{ label: string; text: string }>
  recommended?: string
  sent?: { by: string; runId?: string; at: string; text: string }
  state: string
  preselect: string | null
  reviewAlternative: string | null
  detail: { status: string; artifact?: string }
  actions: WireAction[]
}
export type WireEntry = {
  id: string
  seat: { scopeRef: string; sessionRef: string; online: boolean; generation: number | null }
  key: EntryKey
  expectUpdatedAt: string
  record: { updatedAt: string; updatedBy: string; createdAt: string } | null
  attention: Record<string, unknown> | null
  rows: WireRow[]
  basicCard: { title: string; body: string; attentionAt: string } | null
  actions: WireAction[]
}
export type Snapshot = {
  ok: true
  wire: number
  unchanged?: true
  revision: string
  asOf: string
  home: { node: string; reachable: boolean; ageMs: number; stale: boolean }
  vesta: { online: boolean; sessionRef?: string; generation?: number }
  entries: WireEntry[]
  counts: { openRows: number; openEntries: number }
  capabilities: { actions: string[]; artifacts: boolean; longPoll: boolean }
}
export type ActionResponse = {
  ok: boolean
  outcome: string
  requestId: string
  replayed: boolean
  entry?: WireEntry
  receipt?: {
    node: string
    sessionRef: string
    hostSessionId: string
    generation: number
    runtimeId: string
    runId?: string
    status?: string
  }
  reason?: string
  open?: { node: string; sessionRef: string; hostSessionId: string; generation: number }
  ledger?: { hrcSeq: number }
}

export const SNAPSHOT = '/v1/mobile/c2/v2/snapshot'
export const ACTIONS = '/v1/mobile/c2/v2/actions'

export async function snapshotEntry(acp: C2Acp): Promise<{ snapshot: Snapshot; entry: WireEntry }> {
  const { status, body } = await acp.getJson<Snapshot>(SNAPSHOT)
  if (status !== 200) throw new Error(`GET ${SNAPSHOT} answered ${status}: ${JSON.stringify(body)}`)
  const entry = body.entries.find((e) => e.seat.scopeRef === SEAT)
  if (entry === undefined)
    throw new Error(`fixture seat has no entry in ${JSON.stringify(body.entries)}`)
  return { snapshot: body, entry }
}

/** The recommended answer to the fixture row, exactly as assembled (§12.5). */
export function answerRequest(entry: WireEntry, overrides: Record<string, unknown> = {}) {
  return {
    requestId: newRequestId(),
    key: entry.key,
    expectUpdatedAt: entry.expectUpdatedAt,
    actionId: 'answers',
    kind: 'answer',
    text: ANSWER_TEXT,
    answers: [{ id: 'ship', option: 'Ship' }],
    recommended: true,
    edited: false,
    ...overrides,
  }
}

export function reconcilePath(requestId: string, sessionRef: string): string {
  return `/v1/mobile/c2/v2/actions/${encodeURIComponent(requestId)}?${new URLSearchParams({ sessionRef })}`
}

/** Inputs to the fixture seat itself (not lines to Vesta): steers (rev 5.2 answers) and literal inputs. */
export function seatSends(acp: C2Acp) {
  return acp.fake.calls.filter(
    (call) =>
      (call.path === '/v1/submissions/steer' &&
        (call.body as { target?: string }).target === SEAT_REF) ||
      (call.path === '/v1/literal-input/by-selector' &&
        (call.body as { selector?: { sessionRef?: string } }).selector?.sessionRef === SEAT_REF)
  )
}

/** Wait past a few controller poll periods so background work would have shown. */
/** Wait (bounded, never failing) for the controller to write the fixture seat's first c2.item. */
async function itemWritten(fake: ReturnType<typeof startFakeHrc>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (fake.writes().some((w) => JSON.stringify(w.body).includes('"kind":"item"'))) {
      await settle(150)
      return
    }
    await settle(50)
  }
}

export function settle(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
