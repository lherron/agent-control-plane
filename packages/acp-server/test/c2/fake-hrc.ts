/**
 * A unix-socket HRC double for the C2 mobile cards reds (T-12207).
 *
 * It speaks the real rusthrc wire for exactly the routes the C2 host uses,
 * checked against max3 HRC (rusthrc release-20261031211656176-28630) on
 * 2026-11-01: `GET /v1/sessions` (array of session records), `GET
 * /v1/sessions/attention` (T-12212 shape), the four annotation routes with
 * their admission refusals and HTTP statuses (`hrc-native .../sessions.rs`
 * `annotation_refusal`: invalid 400; unknown_* 404; quota/stale_* 409), and
 * `POST /v1/literal-input/by-selector`, and `GET /v1/runtimes` (T-12233: the
 * runtime record, checked against max3 HRC 2026-11-01: an array of records with
 * `runtimeId`, `hostSessionId`, `generation`, `status`, `runtimeStateJson
 * .terminationReason`; live runtimes only unless `all=true`). Errors use HRC's `{error:{code,
 * message, detail}}` envelope. Any other route answers 404 and is recorded, so
 * an unexpected dependency shows up in `calls`.
 *
 * `literalInput.mode = 'hang'` accepts the request and never answers: the
 * "local socket that accepts and never answers" of the T-12207 timeout suite.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Server } from 'bun'

export type FakeAttention = {
  source: 'jev' | 'tool'
  state: string
  kind: string
  at: string
  excerpt?: string | null
}

export type FakeSeat = {
  scopeRef: string
  hostSessionId: string
  generation: number
  runtimeLive: boolean
  runtimeId: string
  attention: FakeAttention | null
}

export type FakeAnnotation = {
  scopeRef: string
  laneRef: string
  subject: 'seat' | 'generation'
  hostSessionId: string
  generation: number | null
  ns: string
  kind: string
  id: string
  body: Record<string, unknown>
  fence: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type FakeCall = {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  principal: string | null
  at: number
}

export type FakeLedgerEvent = {
  hrcSeq: number
  eventKind: 'session.annotation.action' | 'session.annotation.changed' | 'target.literal-input'
  scopeRef: string
  hostSessionId: string
  generation: number | null
  payload: Record<string, unknown>
}

/** A runtime record as `GET /v1/runtimes` returns it (the fields the C2 host reads). */
export type FakeRuntime = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  status: string
  statusChangedAt?: string
  runtimeStateJson?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type LiteralInputMode = 'accept' | 'accept-no-run' | 'hang'

export type FakeHrc = {
  socketPath: string
  seats: Map<string, FakeSeat>
  annotations: FakeAnnotation[]
  calls: FakeCall[]
  ledger: FakeLedgerEvent[]
  /** Runtime records (`GET /v1/runtimes`); tests add terminated ones. */
  runtimes: FakeRuntime[]
  /** `refuse`: seats whose literal input answers 409 stale_context. */
  literalInput: { mode: LiteralInputMode; refuse: Set<string> }
  /**
   * Seats whose session routes answer an HRC error, as a federated seat whose
   * home is retired or unreachable does (`session_home_pending` 503, …).
   * `routes` limits it to `annotations` and/or `attention`.
   */
  seatErrors: Map<
    string,
    { status: number; code: string; routes: Array<'annotations' | 'attention'> }
  >
  /** Injected latency on every GET (sessions, attention, annotation lists), as a loaded HRC shows. */
  readDelayMs: number
  /** GET reads currently in flight, and the most ever in flight for one scopeRef. */
  inflight: { now: Map<string, number>; max: Map<string, number> }
  /** A direct put, as Vesta's `hrc session annotation put --as agent:vesta` would land. */
  put(row: {
    scopeRef: string
    subject?: 'seat' | 'generation'
    generation?: number | null
    ns?: string
    kind: string
    id: string
    body: Record<string, unknown>
    by?: string
  }): FakeAnnotation
  find(
    scopeRef: string,
    kind: string,
    id: string,
    generation?: number | null
  ): FakeAnnotation | undefined
  literalInputs(): FakeCall[]
  writes(): FakeCall[]
  stop(): Promise<void>
}

const KEY_GRAMMAR = /^[A-Za-z0-9]+$/
const BODY_MAX = 65_536
const QUOTA = 256

function hrcError(status: number, code: string, detail: Record<string, unknown> = {}): Response {
  return Response.json({ error: { code, message: code, detail } }, { status })
}

function canonicalLane(lane: string | undefined): string {
  if (lane === undefined || lane === '') return 'main'
  return lane.startsWith('lane:') ? lane.slice('lane:'.length) : lane
}

export function startFakeHrc(seats: FakeSeat[]): FakeHrc {
  // macOS caps sun_path near 104 bytes; os.tmpdir() under /var/folders is too long.
  const dir = mkdtempSync('/tmp/c2hrc-')
  const socketPath = join(dir, 'hrc.sock')
  const seatMap = new Map(seats.map((seat) => [seat.scopeRef, seat]))
  const annotations: FakeAnnotation[] = []
  const calls: FakeCall[] = []
  const ledger: FakeLedgerEvent[] = []
  const runtimes: FakeRuntime[] = []
  const literalInput: { mode: LiteralInputMode; refuse: Set<string> } = {
    mode: 'accept',
    refuse: new Set(),
  }
  const seatErrors: FakeHrc['seatErrors'] = new Map()
  let lastStamp = 0
  let seq = 1000
  let runCounter = 0
  let stopped = false
  const inflight: FakeHrc['inflight'] = { now: new Map(), max: new Map() }

  function stamp(): string {
    const now = Math.max(Date.now(), lastStamp + 1)
    lastStamp = now
    return new Date(now).toISOString()
  }

  function rowsFor(scopeRef: string, subject: string, generation: number | null): FakeAnnotation[] {
    return annotations.filter(
      (row) =>
        row.scopeRef === scopeRef &&
        row.subject === subject &&
        (subject === 'seat' || row.generation === generation)
    )
  }

  function find(
    scopeRef: string,
    kind: string,
    id: string,
    generation?: number | null
  ): FakeAnnotation | undefined {
    return annotations.find(
      (row) =>
        row.scopeRef === scopeRef &&
        row.kind === kind &&
        row.id === id &&
        (generation === undefined || row.generation === generation)
    )
  }

  function writeRow(input: {
    seat: FakeSeat
    subject: 'seat' | 'generation'
    generation: number | null
    ns: string
    kind: string
    id: string
    body: Record<string, unknown>
    fence: Record<string, unknown> | null
    by: string
  }): { row: FakeAnnotation; created: boolean } {
    const at = stamp()
    const existing = annotations.find(
      (row) =>
        row.scopeRef === input.seat.scopeRef &&
        row.subject === input.subject &&
        row.generation === input.generation &&
        row.ns === input.ns &&
        row.kind === input.kind &&
        row.id === input.id
    )
    if (existing !== undefined) {
      existing.body = structuredClone(input.body)
      existing.fence = input.fence
      existing.updatedAt = at
      existing.updatedBy = input.by
      ledger.push({
        hrcSeq: ++seq,
        eventKind: 'session.annotation.changed',
        scopeRef: input.seat.scopeRef,
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        payload: { kind: input.kind, id: input.id },
      })
      return { row: existing, created: false }
    }
    const row: FakeAnnotation = {
      scopeRef: input.seat.scopeRef,
      laneRef: 'main',
      subject: input.subject,
      hostSessionId: input.subject === 'seat' ? '' : input.seat.hostSessionId,
      generation: input.generation,
      ns: input.ns,
      kind: input.kind,
      id: input.id,
      body: structuredClone(input.body),
      fence: input.fence,
      createdAt: at,
      updatedAt: at,
      updatedBy: input.by,
    }
    annotations.push(row)
    ledger.push({
      hrcSeq: ++seq,
      eventKind: 'session.annotation.changed',
      scopeRef: input.seat.scopeRef,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      payload: { kind: input.kind, id: input.id },
    })
    return { row, created: true }
  }

  function sessionRecord(seat: FakeSeat) {
    return {
      hostSessionId: seat.hostSessionId,
      scopeRef: seat.scopeRef,
      laneRef: 'main',
      generation: seat.generation,
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
  }

  async function annotationRoute(request: Request, url: URL, call: FakeCall): Promise<Response> {
    const input = (
      request.method === 'GET' ? Object.fromEntries(url.searchParams) : call.body
    ) as Record<string, unknown>
    if (typeof input !== 'object' || input === null) {
      return hrcError(400, 'annotation_invalid', { reason: 'body must be an object' })
    }
    const scopeRef = input['scopeRef']
    if (typeof scopeRef !== 'string') {
      return hrcError(400, 'annotation_invalid', { reason: 'scopeRef must be a string' })
    }
    const detail = { scopeRef, laneRef: canonicalLane(input['laneRef'] as string | undefined) }
    const injected = seatErrors.get(scopeRef)
    if (injected?.routes.includes('annotations'))
      return hrcError(injected.status, injected.code, detail)
    const seat = seatMap.get(scopeRef)
    if (seat === undefined) return hrcError(404, 'unknown_host_session', detail)

    if (request.method === 'GET') {
      const generation =
        typeof input['generation'] === 'string' && input['generation'] !== ''
          ? Number(input['generation'])
          : undefined
      const rows = annotations.filter(
        (row) =>
          row.scopeRef === scopeRef &&
          (input['subject'] === undefined || row.subject === input['subject']) &&
          (generation === undefined || row.generation === generation) &&
          (input['ns'] === undefined || row.ns === input['ns']) &&
          (input['kind'] === undefined || row.kind === input['kind'])
      )
      return Response.json({ annotations: structuredClone(rows) })
    }

    const subject = input['subject']
    const ns = input['ns']
    const kind = input['kind']
    const id = input['id']
    if (subject !== 'seat' && subject !== 'generation') {
      return hrcError(400, 'annotation_invalid', { ...detail, reason: 'subject' })
    }
    if (
      typeof ns !== 'string' ||
      !KEY_GRAMMAR.test(ns) ||
      typeof kind !== 'string' ||
      !KEY_GRAMMAR.test(kind)
    ) {
      return hrcError(400, 'annotation_invalid', { ...detail, reason: 'ns/kind grammar' })
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      return hrcError(400, 'annotation_invalid', { ...detail, reason: 'id' })
    }
    const rawGeneration = input['generation']
    if (subject === 'generation' && typeof rawGeneration !== 'number') {
      return hrcError(400, 'annotation_invalid', {
        ...detail,
        reason: 'generation must be an integer',
      })
    }
    const generation = subject === 'generation' ? (rawGeneration as number) : null
    if (generation !== null && (generation < 1 || generation > seat.generation)) {
      return hrcError(404, 'unknown_generation', detail)
    }
    const existing = annotations.find(
      (row) =>
        row.scopeRef === scopeRef &&
        row.subject === subject &&
        row.generation === generation &&
        row.ns === ns &&
        row.kind === kind &&
        row.id === id
    )
    const principal = call.principal ?? 'unknown'

    if (url.pathname === '/v1/sessions/annotations/act') {
      if (existing === undefined) return hrcError(404, 'unknown_annotation', detail)
      const event: FakeLedgerEvent = {
        hrcSeq: ++seq,
        eventKind: 'session.annotation.action',
        scopeRef,
        hostSessionId: existing.hostSessionId,
        generation,
        payload: {
          subject,
          generation,
          ns,
          kind,
          id,
          action: input['action'],
          attributes: input['attributes'] ?? {},
          principal,
        },
      }
      ledger.push(event)
      return Response.json({ hrcSeq: event.hrcSeq })
    }

    const expect = (input['expect'] ?? null) as Record<string, unknown> | null
    if (expect !== null) {
      if ('updatedAt' in expect) {
        if (
          expect['updatedAt'] === null
            ? existing !== undefined
            : existing?.updatedAt !== expect['updatedAt']
        ) {
          return hrcError(409, 'stale_annotation', detail)
        }
      }
      if (typeof expect['generation'] === 'number' && expect['generation'] !== seat.generation) {
        return hrcError(409, 'stale_generation', detail)
      }
      if (
        typeof expect['attentionAt'] === 'string' &&
        seat.attention?.at !== expect['attentionAt']
      ) {
        return hrcError(409, 'stale_attention', detail)
      }
    }

    if (url.pathname === '/v1/sessions/annotations/delete') {
      if (existing === undefined) return Response.json({ deleted: false })
      annotations.splice(annotations.indexOf(existing), 1)
      return Response.json({ deleted: true })
    }

    const body = input['body']
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return hrcError(400, 'annotation_invalid', { ...detail, reason: 'body must be an object' })
    }
    if (JSON.stringify(body).length > BODY_MAX) {
      return hrcError(400, 'annotation_invalid', { ...detail, reason: 'body too large' })
    }
    if (existing === undefined && rowsFor(scopeRef, subject, generation).length >= QUOTA) {
      return hrcError(409, 'annotation_quota', detail)
    }
    const { row, created } = writeRow({
      seat,
      subject,
      generation,
      ns,
      kind,
      id,
      body: body as Record<string, unknown>,
      fence: expect,
      by: principal,
    })
    return Response.json({ annotation: structuredClone(row), created })
  }

  function literalInputRoute(call: FakeCall): Promise<Response> | Response {
    if (literalInput.mode === 'hang') {
      // Accepted, never answered. The connection stays open until stop().
      return new Promise<Response>(() => {})
    }
    const body = call.body as {
      selector?: { sessionRef?: string }
      text?: string
      fences?: { expectedHostSessionId?: string; expectedGeneration?: number }
    }
    const sessionRef = body.selector?.sessionRef ?? ''
    const scopeRef = sessionRef.replace(/\/lane:[^/]+$/, '')
    const seat = seatMap.get(scopeRef)
    if (seat === undefined || !seat.runtimeLive) {
      return hrcError(404, 'unknown_session', { sessionRef })
    }
    if (
      literalInput.refuse.has(scopeRef) ||
      body.fences?.expectedHostSessionId !== seat.hostSessionId ||
      body.fences?.expectedGeneration !== seat.generation
    ) {
      return hrcError(409, 'stale_context', { sessionRef })
    }
    const runId = literalInput.mode === 'accept' ? `run-fake-${++runCounter}` : undefined
    ledger.push({
      hrcSeq: ++seq,
      eventKind: 'target.literal-input',
      scopeRef,
      hostSessionId: seat.hostSessionId,
      generation: seat.generation,
      payload: { text: body.text, runId },
    })
    return Response.json({
      delivered: true,
      sessionRef,
      hostSessionId: seat.hostSessionId,
      generation: seat.generation,
      runtimeId: seat.runtimeId,
      ...(runId !== undefined ? { runId } : {}),
    })
  }

  const server: Server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === 'GET' ? '' : await request.text()
      let body: unknown
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      const call: FakeCall = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        principal: request.headers.get('x-hrc-principal-ref'),
        at: Date.now(),
      }
      calls.push(call)

      if (request.method === 'GET' && fake.readDelayMs > 0) {
        const key = url.searchParams.get('scopeRef') ?? url.pathname
        const now = (inflight.now.get(key) ?? 0) + 1
        inflight.now.set(key, now)
        inflight.max.set(key, Math.max(now, inflight.max.get(key) ?? 0))
        await new Promise((resolve) => setTimeout(resolve, fake.readDelayMs))
        inflight.now.set(key, (inflight.now.get(key) ?? 1) - 1)
      }

      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        const scopeRef = url.searchParams.get('scopeRef')
        const rows = [...seatMap.values()].filter(
          (seat) => scopeRef === null || seat.scopeRef === scopeRef
        )
        return Response.json(rows.map(sessionRecord))
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions/attention') {
        const scopeRef = url.searchParams.get('scopeRef') ?? ''
        const injected = seatErrors.get(scopeRef)
        if (injected?.routes.includes('attention')) {
          return hrcError(injected.status, injected.code, { scopeRef, laneRef: 'main' })
        }
        const seat = seatMap.get(scopeRef)
        if (seat === undefined) {
          return hrcError(404, 'unknown_host_session', { scopeRef, laneRef: 'main' })
        }
        return Response.json({
          scopeRef,
          laneRef: 'main',
          hostSessionId: seat.hostSessionId,
          generation: seat.generation,
          runtimeLive: seat.runtimeLive,
          attention: seat.runtimeLive ? seat.attention : null,
        })
      }
      if (request.method === 'GET' && url.pathname === '/v1/runtimes') {
        const hostSessionId = url.searchParams.get('hostSessionId')
        const scope = url.searchParams.get('scope')
        const all = url.searchParams.get('all') === 'true'
        const rows = runtimes.filter(
          (r) =>
            (hostSessionId === null || r.hostSessionId === hostSessionId) &&
            (scope === null || r.scopeRef === scope) &&
            (all || r.status !== 'terminated')
        )
        return Response.json(structuredClone(rows))
      }
      if (url.pathname.startsWith('/v1/sessions/annotations')) {
        return annotationRoute(request, url, call)
      }
      if (request.method === 'POST' && url.pathname === '/v1/literal-input/by-selector') {
        return literalInputRoute(call)
      }
      return hrcError(404, 'not_found', { path: url.pathname })
    },
  })

  const fake: FakeHrc = {
    socketPath,
    seats: seatMap,
    annotations,
    calls,
    ledger,
    runtimes,
    literalInput,
    seatErrors,
    readDelayMs: 0,
    inflight,
    put(row) {
      const seat = seatMap.get(row.scopeRef)
      if (seat === undefined) throw new Error(`fake HRC: unknown seat ${row.scopeRef}`)
      const subject = row.subject ?? 'generation'
      return writeRow({
        seat,
        subject,
        generation: subject === 'seat' ? null : (row.generation ?? seat.generation),
        ns: row.ns ?? 'c2',
        kind: row.kind,
        id: row.id,
        body: row.body,
        fence: null,
        by: row.by ?? 'agent:vesta',
      }).row
    },
    find,
    literalInputs: () => calls.filter((call) => call.path === '/v1/literal-input/by-selector'),
    writes: () => calls.filter((call) => call.method !== 'GET'),
    async stop() {
      if (stopped) return
      stopped = true
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return fake
}
