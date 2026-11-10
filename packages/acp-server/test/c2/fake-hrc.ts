/**
 * A unix-socket HRC double for the C2 mobile cards reds (T-12207).
 *
 * It speaks the real rusthrc wire for exactly the routes the C2 host uses,
 * checked against max3 HRC (rusthrc release-20261031211656176-28630) on
 * 2026-11-01: `GET /v1/sessions` (array of session records), `GET
 * /v1/sessions/attention` (T-12212 shape), the four annotation routes with
 * their admission refusals and HTTP statuses (`hrc-native .../sessions.rs`
 * `annotation_refusal`: invalid 400; unknown_* 404; quota/stale_* 409), and
 * `POST /v1/literal-input/by-selector`, `GET /v1/events/tail` and the
 * `GET /v1/events?follow=true&fromSeq=` NDJSON stream (T-12421: every ledger
 * event, as `HrcLifecycleEvent` with `hrcSeq`/`scopeRef`; rusthrc appends a
 * session event on every annotation put, delete and act), and `GET /v1/runtimes` (T-12233: the
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
  text?: string
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
  eventKind:
    | 'session.annotation.action'
    | 'session.annotation.changed'
    | 'target.literal-input'
    | 'turn.message'
    | 'runtime.state'
    | 'session.created'
    | 'session.archived'
    | 'runtime.terminated'
  scopeRef: string
  hostSessionId: string
  generation: number | null
  runtimeId?: string
  payload: Record<string, unknown>
}

/**
 * A seat handoff as `GET /v1/seat-handoffs` lists it (T-12715, checked against max3 HRC 57000d0a on
 * 2026-11-07: `{handoffs: [...]}`, newest first, keyed by the full seat `scopeRef`; `project=` matches the
 * seat's project; pending only unless `all=true`).
 */
export type FakeHandoff = {
  id: string
  scopeRef: string
  laneRef: string
  title: string
  body: string
  state: 'pending' | 'acknowledged'
  etag: number
  createdAt: string
  acknowledgedAt: string | null
  note: string | null
  legacyScope: null
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
  /** HRC's generic end (`process-exit` on a self-restart, T-12715); the event carries the real reason. */
  lifecycleTerminalReason?: string | null
  createdAt: string
  updatedAt: string
}

export type LiteralInputMode = 'accept' | 'accept-no-run' | 'hang'
/**
 * `POST /v1/submissions/steer` (card contract rev 5.2, T-13271), shaped from max3 HRC's replies on 2026-11-10
 * (T-13271 artifacts sdk-steer-{idle,busy,replay}.json, probe-steer-self.json). `accept`: admitted, effectiveDoor
 * steer. `downgrade`: admitted, effectiveDoor enqueue, steer_not_supported. `reject`: admission rejected, reason
 * guarded. `lost`: admitted with a cursorless lost disposition and no runId. `hang`: accepted, never answered.
 * A repeated idempotencyKey replays the first admission: same runId, `replayed: true`, no door report.
 */
export type SteerMode = 'accept' | 'downgrade' | 'reject' | 'lost' | 'hang'

export type FakeHrc = {
  socketPath: string
  status: { node: { nodeId: string; mode: string }; startedAt: string }
  seats: Map<string, FakeSeat>
  annotations: FakeAnnotation[]
  calls: FakeCall[]
  ledger: FakeLedgerEvent[]
  /** Runtime records (`GET /v1/runtimes`); tests add terminated ones. */
  runtimes: FakeRuntime[]
  /** Seat handoffs (`GET /v1/seat-handoffs`); tests add them. */
  handoffs: FakeHandoff[]
  /** The seat-handoffs list answers this HRC error. */
  handoffsRefuse?: { status: number; code: string } | undefined
  /** Append a ledger event as HRC does, e.g. `runtime.terminated` with `{reason}` on a runtime. */
  emit(event: Omit<FakeLedgerEvent, 'hrcSeq'>): void
  /** `refuse`: seats whose literal input answers 409 stale_context. */
  literalInput: { mode: LiteralInputMode; refuse: Set<string> }
  steer: { mode: SteerMode }
  /**
   * §2.13 keyed start, as the real routes answered on 2026-11-05 (T-12645 live/summon/real-*.json): declaration
   * resolve, then exact claim-and-start (replayed by `idempotencyKey`), then `POST /v1/sessions/resolve` for the head.
   * `refuse`: the route answers this HRC error. `hang`: the start is accepted and never answered.
   */
  start: {
    declarationRefuse?: { status: number; code: string } | undefined
    startRefuse?: { status: number; code: string } | undefined
    hang?: boolean | undefined
  }
  /**
   * Seats whose session routes answer an HRC error, as a federated seat whose
   * home is retired or unreachable does (`session_home_pending` 503, …).
   * `routes` limits it to `annotations` and/or `attention`.
   */
  seatErrors: Map<
    string,
    { status: number; code: string; routes: Array<'annotations' | 'attention'> }
  >
  /**
   * The event routes. `enabled: false` answers them 404 (an HRC without the
   * follow route); `drop()` severs every open follow stream.
   */
  events: {
    enabled: boolean
    incarnation: string
    followers(): number
    drop(): void
    control(value: Record<string, unknown>): void
  }
  /** Append a seat event, as HRC does for a change the test makes directly on `seats`. */
  touch(scopeRef: string, eventKind?: FakeLedgerEvent['eventKind']): void
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
  steers(): FakeCall[]
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
  const followers = new Set<{ push(event: FakeLedgerEvent): void; close(): void }>()
  /** Every ledger append reaches the open follow streams. */
  function append(event: FakeLedgerEvent): void {
    ledger.push(event)
    for (const follower of followers) follower.push(event)
  }
  function wireEvent(event: FakeLedgerEvent) {
    return {
      hrcSeq: event.hrcSeq,
      streamSeq: event.hrcSeq,
      ts: new Date().toISOString(),
      hostSessionId: event.hostSessionId,
      scopeRef: event.scopeRef,
      laneRef: 'main',
      generation: event.generation ?? 0,
      ...(event.runtimeId !== undefined ? { runtimeId: event.runtimeId } : {}),
      category: event.eventKind.split('.')[0],
      eventKind: event.eventKind,
      eventJson: event.payload,
      payload: event.payload,
    }
  }
  const controls = new Set<(value: Record<string, unknown>) => void>()
  const runtimes: FakeRuntime[] = []
  const handoffs: FakeHandoff[] = []
  const literalInput: { mode: LiteralInputMode; refuse: Set<string> } = {
    mode: 'accept',
    refuse: new Set(),
  }
  const steer: { mode: SteerMode } = { mode: 'accept' }
  const steerReplays = new Map<string, Record<string, unknown>>()
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
      append({
        hrcSeq: ++seq,
        eventKind: 'session.annotation.changed',
        scopeRef: input.seat.scopeRef,
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        payload: { ns: input.ns, kind: input.kind, id: input.id },
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
    append({
      hrcSeq: ++seq,
      eventKind: 'session.annotation.changed',
      scopeRef: input.seat.scopeRef,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      payload: { ns: input.ns, kind: input.kind, id: input.id },
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
      append(event)
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
      append({
        hrcSeq: ++seq,
        eventKind: 'session.annotation.changed',
        scopeRef,
        hostSessionId: existing.hostSessionId,
        generation,
        payload: { op: 'delete', kind, id },
      })
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

  const start: FakeHrc['start'] = {}
  const started = new Map<string, { runtimeId: string; hostSessionId: string }>()
  function declarationsRoute(call: FakeCall): Response {
    if (start.declarationRefuse) {
      return hrcError(start.declarationRefuse.status, start.declarationRefuse.code, {
        source: 'agent-profile',
      })
    }
    const body = call.body as { scopeRef?: string; runMode?: string; preferredMode?: string }
    return Response.json({
      declaration: { warnings: [] },
      intent: {
        placement: {
          agentRoot: '/agents/x',
          cwd: '/x',
          projectRoot: '/x',
          runMode: body.runMode,
          bundle: {},
          dryRun: false,
        },
        execution: { preferredMode: body.preferredMode },
        harness: {},
        provision: {},
      },
    })
  }
  function startRoute(call: FakeCall): Promise<Response> | Response {
    if (start.hang) return new Promise<Response>(() => {})
    if (start.startRefuse) return hrcError(start.startRefuse.status, start.startRefuse.code, {})
    const body = call.body as { sessionRef: string; idempotencyKey: string }
    const scopeRef = body.sessionRef.replace(/\/lane:[^/]+$/, '')
    const seat = seatMap.get(scopeRef)
    if (seat === undefined) return hrcError(404, 'unknown_session', {})
    let up = started.get(body.idempotencyKey)
    const replayed = up !== undefined
    if (up === undefined) {
      up = {
        runtimeId: `rt-started-${started.size + 1}`,
        hostSessionId: `hsid-started-${started.size + 1}`,
      }
      started.set(body.idempotencyKey, up)
      seat.hostSessionId = up.hostSessionId
      seat.runtimeId = up.runtimeId
      seat.generation += 1
      seat.runtimeLive = true
    }
    return Response.json({
      ...up,
      transport: 'headless',
      status: 'ready',
      supportsInFlightInput: true,
      claim: { scopeRef, sessionRef: body.sessionRef, replayed },
    })
  }
  function sessionResolveRoute(call: FakeCall): Response {
    const sessionRef = (call.body as { sessionRef?: string }).sessionRef ?? ''
    const scopeRef = sessionRef.replace(/\/lane:[^/]+$/, '')
    const seat = seatMap.get(scopeRef)
    if (seat === undefined) return Response.json({ found: false })
    return Response.json({
      found: true,
      created: false,
      hostSessionId: seat.hostSessionId,
      generation: seat.generation,
      homeNodeId: null,
      session: {
        scopeRef,
        laneRef: 'main',
        generation: seat.generation,
        hostSessionId: seat.hostSessionId,
        status: 'active',
      },
    })
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
    append({
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

  function steerRoute(call: FakeCall): Promise<Response> | Response {
    if (steer.mode === 'hang') return new Promise<Response>(() => {})
    const body = call.body as { target?: string; body?: string; idempotencyKey?: string }
    const key = body.idempotencyKey
    const prior = key !== undefined ? steerReplays.get(key) : undefined
    if (prior !== undefined) {
      const { effectiveDoor: _door, requestedDoor: _req, downgradeReason: _why, ...rest } = prior
      return Response.json({ ...rest, replayed: true, effectiveDoor: null })
    }
    const sessionRef = body.target ?? ''
    const scopeRef = sessionRef.replace(/\/lane:[^/]+$/, '')
    const seat = seatMap.get(scopeRef)
    if (seat === undefined || !seat.runtimeLive) {
      return hrcError(404, 'unknown_session', { sessionRef })
    }
    const submissionId = `submission_fake_${++runCounter}`
    if (steer.mode === 'reject') {
      return Response.json({
        admission: 'rejected',
        disposition: { type: 'rejected', reason: 'guarded' },
        effectiveDoor: 'steer',
        reason: 'guarded',
        submissionId,
      })
    }
    if (steer.mode === 'lost') {
      return Response.json({
        admission: 'admitted',
        disposition: { type: 'lost' },
        effectiveDoor: 'steer',
        submissionId,
      })
    }
    const runId = `run-fake-${runCounter}`
    append({
      hrcSeq: ++seq,
      eventKind: 'submission.admission',
      scopeRef,
      hostSessionId: seat.hostSessionId,
      generation: seat.generation,
      payload: {
        text: body.body,
        runId,
        effectiveDoor: steer.mode === 'downgrade' ? 'enqueue' : 'steer',
      },
    })
    const reply: Record<string, unknown> = {
      runId,
      hostSessionId: seat.hostSessionId,
      generation: seat.generation,
      runtimeId: seat.runtimeId,
      transport: 'headless',
      status: 'accepted',
      supportsInFlightInput: false,
      submissionId,
      admission: 'admitted',
      startIdentity: { kind: 'broker', invocationId: 'inv-fake' },
      observation: {},
      stage: 'accepted',
      replayed: false,
      executionFormat: 'format1',
      ...(steer.mode === 'downgrade'
        ? {
            effectiveDoor: 'enqueue',
            requestedDoor: 'steer',
            downgradeReason: 'steer_not_supported',
          }
        : { effectiveDoor: 'steer' }),
    }
    if (key !== undefined) steerReplays.set(key, reply)
    return Response.json(reply)
  }

  function eventsRoute(url: URL): Response {
    if (!fake.events.enabled) return hrcError(404, 'not_found', { path: url.pathname })
    if (url.pathname === '/v1/events/tail') {
      const limit = Number(url.searchParams.get('limit') ?? '100')
      // HRC filters the tail by these fields (hrc-sdk eventFilterParams).
      const runtimeId = url.searchParams.get('runtimeId')
      const eventKind = url.searchParams.get('eventKind')
      const matched = ledger.filter(
        (e) =>
          (runtimeId === null || e.runtimeId === runtimeId) &&
          (eventKind === null || e.eventKind === eventKind)
      )
      return Response.json({
        events: matched.slice(-limit).map(wireEvent),
        ledgerIncarnationId: fake.events.incarnation,
        headHrcSeq: seq,
        truncated: matched.length > limit,
      })
    }
    const bounded = url.pathname === '/v1/events/bounded-stream'
    const fromSeq = bounded
      ? Number(url.searchParams.get('afterSeq') ?? '0') + 1
      : Number(url.searchParams.get('fromSeq') ?? '1')
    if (url.searchParams.get('follow') !== 'true') {
      const rows = ledger.filter((event) => event.hrcSeq >= fromSeq).map(wireEvent)
      return new Response(rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    }
    const encoder = new TextEncoder()
    let follower: { push(event: FakeLedgerEvent): void; close(): void } | undefined
    let control: ((value: Record<string, unknown>) => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const self: { push(event: FakeLedgerEvent): void; close(): void } = {
          push(event) {
            if (event.hrcSeq < fromSeq) return
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify(bounded ? { type: 'event', ledgerIncarnationId: fake.events.incarnation, event: wireEvent(event) } : wireEvent(event))}\n`
              )
            )
          },
          close() {
            followers.delete(self)
            if (control) controls.delete(control)
            try {
              controller.close()
            } catch {}
          },
        }
        follower = self
        if (bounded) {
          control = (value) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
          controls.add(control)
        }
        if (bounded)
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: 'ready',
                ledgerIncarnationId: fake.events.incarnation,
                acceptedAfterHrcSeq: fromSeq - 1,
                replayHeadHrcSeq: seq,
              })}\n`
            )
          )
        for (const event of ledger) self.push(event)
        followers.add(self)
      },
      cancel() {
        if (follower !== undefined) followers.delete(follower)
        if (control) controls.delete(control)
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-hrc-streaming': '1' },
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

      if (
        url.pathname === '/v1/events' ||
        url.pathname === '/v1/events/tail' ||
        url.pathname === '/v1/events/bounded-stream'
      ) {
        return eventsRoute(url)
      }

      if (request.method === 'GET' && fake.readDelayMs > 0) {
        const key = url.searchParams.get('scopeRef') ?? url.pathname
        const now = (inflight.now.get(key) ?? 0) + 1
        inflight.now.set(key, now)
        inflight.max.set(key, Math.max(now, inflight.max.get(key) ?? 0))
        await new Promise((resolve) => setTimeout(resolve, fake.readDelayMs))
        inflight.now.set(key, (inflight.now.get(key) ?? 1) - 1)
      }

      if (url.pathname === '/v1/status') return Response.json(fake.status)
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
      if (request.method === 'GET' && url.pathname === '/v1/seat-handoffs') {
        if (fake.handoffsRefuse !== undefined)
          return hrcError(fake.handoffsRefuse.status, fake.handoffsRefuse.code)
        const scopeRef = url.searchParams.get('scopeRef')
        const project = url.searchParams.get('project')
        if (scopeRef === null && project === null)
          return hrcError(400, 'invalid_request', { reason: 'scopeRef or project is required' })
        const all = url.searchParams.get('all') === 'true'
        const rows = handoffs
          .filter(
            (h) =>
              (scopeRef === null || h.scopeRef === scopeRef) &&
              (project === null || /:project:([^:]+)/.exec(h.scopeRef)?.[1] === project) &&
              (all || h.state === 'pending')
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        return Response.json({ handoffs: structuredClone(rows) })
      }
      if (url.pathname.startsWith('/v1/sessions/annotations')) {
        return annotationRoute(request, url, call)
      }
      if (request.method === 'POST' && url.pathname === '/v1/declarations/resolve')
        return declarationsRoute(call)
      if (request.method === 'POST' && url.pathname === '/v1/runtimes/start')
        return startRoute(call)
      if (request.method === 'POST' && url.pathname === '/v1/sessions/resolve')
        return sessionResolveRoute(call)
      if (request.method === 'POST' && url.pathname === '/v1/literal-input/by-selector') {
        return literalInputRoute(call)
      }
      if (request.method === 'POST' && url.pathname === '/v1/submissions/steer')
        return steerRoute(call)
      return hrcError(404, 'not_found', { path: url.pathname })
    },
  })

  const fake: FakeHrc = {
    socketPath,
    status: { node: { nodeId: 'max3', mode: 'single-node' }, startedAt: 'fake-start' },
    seats: seatMap,
    annotations,
    calls,
    ledger,
    runtimes,
    handoffs,
    emit(event) {
      append({ ...event, hrcSeq: ++seq })
    },
    literalInput,
    steer,
    start,
    seatErrors,
    events: {
      enabled: true,
      incarnation: 'fake-ledger',
      control(value) {
        for (const send of controls) send(value)
      },
      followers: () => followers.size,
      drop() {
        for (const follower of [...followers]) follower.close()
      },
    },
    touch(scopeRef, eventKind = 'turn.message') {
      const seat = seatMap.get(scopeRef)
      if (seat === undefined) throw new Error(`fake HRC: unknown seat ${scopeRef}`)
      append({
        hrcSeq: ++seq,
        eventKind,
        scopeRef,
        hostSessionId: seat.hostSessionId,
        generation: seat.generation,
        payload: {},
      })
    },
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
    steers: () => calls.filter((call) => call.path === '/v1/submissions/steer'),
    writes: () => calls.filter((call) => call.method !== 'GET'),
    async stop() {
      if (stopped) return
      stopped = true
      fake.events.drop()
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return fake
}
