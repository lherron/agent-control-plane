/**
 * Ephemeral ACP for the C2 mobile cards reds (T-12207): the real router and
 * listener handlers on a Bun.serve TCP port, a real hrc-sdk `HrcClient` over
 * the fake HRC unix socket, and a disposable fixture seat with one Vesta card.
 * Nothing here touches a real seat or a human card.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HrcClient } from 'hrc-sdk'

import { createAcpListenerHandlers } from '../../src/acp-listener.js'
import type { AcpC2Config } from '../../src/c2/config.js'
import { type AcpHrcClient, type AcpServerDeps, resolveAcpServerDeps } from '../../src/deps.js'
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
export const REPLY_TEXT = 'Ship it; the fixture is disposable.'
export const SCOPE_ALLOW = ['^agent:smokey:project:c2:task:c2fixture-[a-z0-9-]+$']

export type C2Roots = { wrkqArtifacts: string; scratchC2: string; outside: string }

export type C2Acp = {
  base: string
  fake: FakeHrc
  wired: WiredServerFixture
  roots: C2Roots
  /** Raw bytes of the card's evidence image (the full-resolution control). */
  imageBytes: Uint8Array
  imagePath: string
  htmlPath: string
  card(): FakeAnnotation
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
      },
    },
  ]
}

export function cardBody(paths: { image: string; html: string }): Record<string, unknown> {
  return {
    v: 4,
    source: 'vesta',
    attentionAt: ATTENTION_AT,
    title: 'Ship the disposable fixture?',
    blocked: 'The fixture seat waits for a yes or no.',
    recommendation: { action: 'ship', why: 'It is disposable.' },
    actions: [
      { id: 'ship', kind: 'reply', label: 'Ship it', text: REPLY_TEXT },
      { id: 'write', kind: 'compose', label: 'Write', draft: '' },
      { kind: 'jump', label: 'Open session' },
      { id: 'later', kind: 'snooze', label: 'Later', minutes: 30 },
    ],
    evidence: [
      { label: 'excerpt', text: 'Ship the fixture?' },
      { label: 'look', image: paths.image },
    ],
    detailRef: paths.html,
    createdAt: ATTENTION_AT,
    state: 'open',
  }
}

/** The ACP §5 artifact id encoding, for forged-id refusals. */
export function forgeArtifactId(input: {
  key: Record<string, unknown>
  updatedAt: string
  field: 'evidence' | 'detail'
  index: number
}): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url')
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

  // 3 MiB of deterministic bytes: large enough that any thumbnailing shows.
  const imageBytes = new Uint8Array(3 * 1024 * 1024)
  for (let i = 0; i < imageBytes.length; i += 1) imageBytes[i] = (i * 31 + 7) & 0xff
  const imagePath = join(roots.wrkqArtifacts, 'T-00000', 'look.png')
  mkdirSync(join(roots.wrkqArtifacts, 'T-00000'), { recursive: true })
  writeFileSync(imagePath, imageBytes)
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
    generation: 2,
    kind: 'card',
    id: ATTENTION_AT,
    body: cardBody({ image: imagePath, html: htmlPath }),
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
  const hrcClient: AcpHrcClient = new HrcClient({
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
        imageBytes,
        imagePath,
        htmlPath,
        card() {
          const row = fake.find(SEAT, 'card', ATTENTION_AT, 2)
          if (row === undefined) throw new Error('fixture card missing')
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

// ---- wire shapes the reds read (T-12205 r2.1 "Mobile wire contract") ----

export type CardKey = {
  sessionRef: string
  subject: 'generation'
  generation: number
  ns: 'c2'
  kind: 'card' | 'ask'
  id: string
}
export type WireAction = {
  id: string
  kind: string
  label: string
  text?: string
  minutes?: number
  draft?: string
}
export type WireCard = {
  id: string
  key: CardKey
  createdAt: string
  updatedAt: string
  updatedBy: string
  source: string
  state: string
  title: string
  actions: WireAction[]
  evidence: Array<{ label: string; text?: string; image?: { artifact: string } }>
  detail: { status: string; artifact?: string }
  pending: { actionId: string; requestId: string; at: string } | null
  seat: {
    node: string
    scopeRef: string
    sessionRef: string
    hostSessionId: string
    generation: number
    attentionAt: string | null
    online: boolean
  }
  runId?: string
  sentText?: string
}
export type Snapshot = {
  ok: true
  unchanged?: true
  revision: string
  asOf: string
  home: { node: string; reachable: boolean; ageMs: number; stale: boolean }
  vesta: { online: boolean; sessionRef?: string; hostSessionId?: string; generation?: number }
  seats: Array<{
    scopeRef: string
    agent: string
    project: string
    seat: string
    online: boolean
    card: WireCard | null
    drafting: boolean
  }>
  asks: WireCard[]
  recent: WireCard[]
  counts: { waiting: number; asks: number }
  capabilities: { actions: string[]; artifacts: boolean; longPoll: boolean }
}
export type ActionResponse = {
  ok: boolean
  outcome: string
  requestId: string
  replayed: boolean
  card?: WireCard
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

export async function snapshotCard(acp: C2Acp): Promise<{ snapshot: Snapshot; card: WireCard }> {
  const { status, body } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
  if (status !== 200) {
    throw new Error(`GET /v1/mobile/c2/cards answered ${status}: ${JSON.stringify(body)}`)
  }
  const card = body.seats.find((row) => row.scopeRef === SEAT)?.card
  if (card === null || card === undefined) {
    throw new Error(`fixture seat has no card in ${JSON.stringify(body.seats)}`)
  }
  return { snapshot: body, card }
}

export function replyRequest(card: WireCard, overrides: Record<string, unknown> = {}) {
  const action = card.actions.find((candidate) => candidate.kind === 'reply')
  if (action === undefined) throw new Error('fixture card has no reply action')
  return {
    requestId: newRequestId(),
    key: card.key,
    expectUpdatedAt: card.updatedAt,
    actionId: action.id,
    kind: 'reply',
    text: action.text,
    recommended: true,
    edited: false,
    ...overrides,
  }
}

export function reconcilePath(requestId: string, key: CardKey): string {
  const query = new URLSearchParams({
    sessionRef: key.sessionRef,
    generation: String(key.generation),
  })
  return `/v1/mobile/c2/actions/${encodeURIComponent(requestId)}?${query}`
}

/** Literal inputs to the fixture card's own seat (not the acted line to Vesta). */
export function seatSends(acp: C2Acp) {
  return acp.fake
    .literalInputs()
    .filter(
      (call) =>
        (call.body as { selector?: { sessionRef?: string } }).selector?.sessionRef === SEAT_REF
    )
}

/** Wait past a few controller poll periods so background work would have shown. */
export function settle(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
