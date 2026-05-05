import type {
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import { badRequest, json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

const GATEWAY_ID = 'acp-local'
const API_VERSION = 'v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:18470'

type MobileSessionMode = 'interactive' | 'headless'
type MobileSessionStatus = 'active' | 'stale' | 'inactive'
type MobileExecutionMode = 'interactive' | 'headless' | 'nonInteractive'

type MobileSessionSummary = {
  sessionRef: string
  displayRef: string
  title: string
  mode: MobileSessionMode
  executionMode: MobileExecutionMode
  status: MobileSessionStatus
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  activeTurnId?: string | undefined
  lastHrcSeq: number
  lastMessageSeq: number
  lastActivityAt?: string | undefined
  capabilities: {
    input: boolean
    interrupt: boolean
    launchHeadlessTurn: boolean
    history: boolean
  }
}

type MobileSessionIndex = {
  refreshedAt: string
  counts: {
    all: number
    interactive: number
    headless: number
    active: number
    stale: number
    inactive: number
  }
  sessions: MobileSessionSummary[]
}

type MobileEventMessage = {
  type: 'hrc_event'
  hrcSeq: number
  streamSeq: number
  eventKind: string
  category: string
  ts: string
  payload: unknown
  scopeRef?: string | undefined
  laneRef?: string | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  replayed?: boolean | undefined
  errorCode?: string | undefined
}

type MobileTimelineFrame = {
  frameId: string
  frameSeq: number
  lastHrcSeq: number
  lastMessageSeq?: number | undefined
  sessionRef: string
  mode: MobileSessionMode
  frameKind:
    | 'user_prompt'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'tool_batch'
    | 'patch_summary'
    | 'diff_summary'
    | 'turn_status'
    | 'session_status'
    | 'input_ack'
    | 'error'
  sourceEvents: Array<{ hrcSeq: number; eventKind: string }>
  blocks: Array<{
    kind:
      | 'markdown'
      | 'mono'
      | 'tool_call'
      | 'tool_result'
      | 'command_ledger'
      | 'patch_summary'
      | 'diff_summary'
      | 'status'
      | 'raw_json'
    text?: string | undefined
    language?: string | undefined
    toolName?: string | undefined
    toolUseId?: string | undefined
    status?: string | undefined
    payload?: unknown
  }>
  actions: Array<{ actionId: string; label: string; enabled: boolean }>
  runId?: string | undefined
  turnId?: string | undefined
  ts: string
}

type MobileHistoryPage = {
  frames: MobileTimelineFrame[]
  oldestCursor: { hrcSeq: number; messageSeq: number }
  newestCursor: { hrcSeq: number; messageSeq: number }
  hasMoreBefore: boolean
  events?: MobileEventMessage[] | undefined
}

type MobileWebSocketData = {
  deps: ResolvedAcpServerDeps
  url: string
  kind: 'timeline' | 'diagnostics'
  abortController: AbortController
}

type MobileWebSocket = {
  data: MobileWebSocketData
  send(message: string): number | undefined
  close(code?: number, reason?: string): void
}

function requireHrcClient(deps: ResolvedAcpServerDeps): AcpHrcClient {
  if (deps.hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }
  return deps.hrcClient
}

function sessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

function latestRuntimeForSession(
  session: HrcSessionRecord,
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  const matches = runtimes.filter((runtime) => runtime.hostSessionId === session.hostSessionId)
  return matches.sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))[0]
}

function executionMode(
  session: HrcSessionRecord,
  runtime?: HrcRuntimeSnapshot
): MobileExecutionMode {
  const preferred = session.lastAppliedIntentJson?.execution?.preferredMode
  if (preferred === 'headless' || preferred === 'interactive' || preferred === 'nonInteractive') {
    return preferred
  }
  if (runtime?.transport === 'headless') return 'headless'
  return runtime?.supportsInflightInput === true ? 'interactive' : 'nonInteractive'
}

function mobileMode(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  if (execution === 'headless' || runtime?.transport === 'headless') return 'headless'
  return 'interactive'
}

function mobileStatus(status: string, runtime?: HrcRuntimeSnapshot): MobileSessionStatus {
  const normalized = status.toLowerCase()
  if (normalized.includes('stale')) return 'stale'
  if (
    normalized.includes('inactive') ||
    normalized.includes('archived') ||
    normalized.includes('closed') ||
    normalized.includes('terminated')
  ) {
    return 'inactive'
  }
  if (runtime?.status.toLowerCase().includes('stale')) return 'stale'
  return 'active'
}

function titleForSession(record: HrcSessionRecord): string {
  const parts = record.scopeRef.split('/')
  return parts[parts.length - 1] || record.scopeRef
}

function projectSession(input: {
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
  lastEvent?: HrcLifecycleEvent | undefined
}): MobileSessionSummary {
  const execution = executionMode(input.record, input.runtime)
  const mode = mobileMode(execution, input.runtime)
  const status = mobileStatus(input.record.status, input.runtime)
  const runtimeActive = input.runtime?.status.toLowerCase() === 'active'
  const supportsInput = mode === 'interactive' && input.runtime?.supportsInflightInput === true

  return {
    sessionRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    displayRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    title: titleForSession(input.record),
    mode,
    executionMode: execution,
    status,
    hostSessionId: input.record.hostSessionId,
    generation: input.record.generation,
    ...(input.runtime?.runtimeId !== undefined ? { runtimeId: input.runtime.runtimeId } : {}),
    ...(input.runtime?.activeRunId !== undefined
      ? { activeTurnId: input.runtime.activeRunId }
      : {}),
    lastHrcSeq: input.lastEvent?.hrcSeq ?? 0,
    lastMessageSeq: 0,
    lastActivityAt: input.lastEvent?.ts ?? input.runtime?.lastActivityAt ?? input.record.updatedAt,
    capabilities: {
      input: supportsInput,
      interrupt: runtimeActive || input.runtime !== undefined,
      launchHeadlessTurn: false,
      history: true,
    },
  }
}

function countSessions(sessions: MobileSessionSummary[]): MobileSessionIndex['counts'] {
  return {
    all: sessions.length,
    interactive: sessions.filter((session) => session.mode === 'interactive').length,
    headless: sessions.filter((session) => session.mode === 'headless').length,
    active: sessions.filter((session) => session.status === 'active').length,
    stale: sessions.filter((session) => session.status === 'stale').length,
    inactive: sessions.filter((session) => session.status === 'inactive').length,
  }
}

async function collectEvents(
  hrcClient: AcpHrcClient,
  options: Parameters<AcpHrcClient['watch']>[0],
  limit = 500
): Promise<HrcLifecycleEvent[]> {
  const events: HrcLifecycleEvent[] = []
  for await (const event of hrcClient.watch(options)) {
    events.push(event)
    if (events.length >= limit) break
  }
  return events
}

async function collectMessages(
  hrcClient: AcpHrcClient,
  options: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    beforeMessageSeq?: number | undefined
    limit?: number | undefined
  }
): Promise<HrcMessageRecord[]> {
  const response = await hrcClient.listMessages({
    ...(options.hostSessionId !== undefined ? { hostSessionId: options.hostSessionId } : {}),
    ...(options.generation !== undefined ? { generation: options.generation } : {}),
    order: 'desc',
    limit: Math.max(options.limit ?? 80, 1),
  })
  return response.messages
    .filter(
      (message) =>
        options.beforeMessageSeq === undefined || message.messageSeq < options.beforeMessageSeq
    )
    .filter(
      (message) =>
        options.sessionRef === undefined ||
        message.execution.sessionRef === undefined ||
        message.execution.sessionRef === options.sessionRef ||
        addressSessionRef(message.from) === options.sessionRef ||
        addressSessionRef(message.to) === options.sessionRef
    )
    .slice(0, options.limit ?? 80)
}

async function listMobileSessions(
  deps: ResolvedAcpServerDeps,
  url: URL
): Promise<MobileSessionIndex> {
  const hrcClient = requireHrcClient(deps)
  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined
  const mode = url.searchParams.get('mode')
  const status = url.searchParams.get('status')
  const query = url.searchParams.get('q')?.trim().toLowerCase()

  const [records, runtimes, events] = await Promise.all([
    hrcClient.listSessions({
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
    }),
    hrcClient.listRuntimes({}),
    collectEvents(hrcClient, { follow: false }, 2_000),
  ])

  const latestEventByHostSessionId = new Map<string, HrcLifecycleEvent>()
  for (const event of events) {
    const previous = latestEventByHostSessionId.get(event.hostSessionId)
    if (previous === undefined || event.hrcSeq > previous.hrcSeq) {
      latestEventByHostSessionId.set(event.hostSessionId, event)
    }
  }

  let sessions = records.map((record) =>
    projectSession({
      record,
      runtime: latestRuntimeForSession(record, runtimes),
      lastEvent: latestEventByHostSessionId.get(record.hostSessionId),
    })
  )

  if (mode === 'interactive' || mode === 'headless') {
    sessions = sessions.filter((session) => session.mode === mode)
  }
  if (status === 'active' || status === 'stale' || status === 'inactive') {
    sessions = sessions.filter((session) => session.status === status)
  }
  if (query !== undefined && query.length > 0) {
    sessions = sessions.filter((session) =>
      [
        session.sessionRef,
        session.displayRef,
        session.title,
        session.hostSessionId,
        session.runtimeId ?? '',
        session.activeTurnId ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }

  sessions.sort((lhs, rhs) => (rhs.lastActivityAt ?? '').localeCompare(lhs.lastActivityAt ?? ''))
  return {
    refreshedAt: new Date().toISOString(),
    counts: countSessions(sessions),
    sessions,
  }
}

function projectEvent(event: HrcLifecycleEvent): MobileEventMessage {
  return {
    type: 'hrc_event',
    hrcSeq: event.hrcSeq,
    streamSeq: event.streamSeq,
    eventKind: event.eventKind,
    category: event.category,
    ts: event.ts,
    payload: event.payload,
    scopeRef: event.scopeRef,
    laneRef: event.laneRef,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    ...(event.runtimeId !== undefined ? { runtimeId: event.runtimeId } : {}),
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ...(event.launchId !== undefined ? { launchId: event.launchId } : {}),
    replayed: event.replayed,
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
  }
}

function frameKind(event: HrcLifecycleEvent): MobileTimelineFrame['frameKind'] {
  if (event.errorCode !== undefined || event.category === 'inflight') return 'error'
  if (event.category === 'session') return 'session_status'
  if (event.category === 'turn' || event.category === 'runtime' || event.category === 'launch') {
    return 'turn_status'
  }
  return 'session_status'
}

function frameText(event: HrcLifecycleEvent): string {
  return `${event.eventKind} · ${event.category}`
}

function projectFrame(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame {
  return {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    frameKind: frameKind(event),
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    blocks: [
      {
        kind: 'status',
        text: frameText(event),
        status: event.eventKind,
      },
      {
        kind: 'raw_json',
        language: 'json',
        payload: event.payload,
      },
    ],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }
}

type TimelineInput =
  | { kind: 'event'; event: HrcLifecycleEvent }
  | { kind: 'message'; message: HrcMessageRecord }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function addressSessionRef(address: HrcMessageAddress): string | undefined {
  return address.kind === 'session' ? address.sessionRef : undefined
}

function sessionRefFromMessage(message: HrcMessageRecord, fallbackSessionRef?: string): string {
  return (
    message.execution.sessionRef ??
    addressSessionRef(message.from) ??
    addressSessionRef(message.to) ??
    fallbackSessionRef ??
    'unknown/lane:main'
  )
}

function messageIsFromHuman(message: HrcMessageRecord): boolean {
  return message.from.kind === 'entity' && message.from.entity === 'human'
}

function messageIsToHuman(message: HrcMessageRecord): boolean {
  return message.to.kind === 'entity' && message.to.entity === 'human'
}

function projectMessage(
  message: HrcMessageRecord,
  fallbackSessionRef?: string,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame | undefined {
  const frameKind: MobileTimelineFrame['frameKind'] =
    message.phase === 'response' || messageIsToHuman(message)
      ? 'assistant_message'
      : message.phase === 'request' || message.phase === 'oneway' || messageIsFromHuman(message)
        ? 'user_prompt'
        : 'session_status'

  if (frameKind === 'session_status' && message.body.trim().length === 0) return undefined

  return {
    frameId: `msg-${message.messageSeq}`,
    frameSeq: message.messageSeq,
    lastHrcSeq: 0,
    lastMessageSeq: message.messageSeq,
    sessionRef: sessionRefFromMessage(message, fallbackSessionRef),
    mode,
    frameKind,
    sourceEvents: [],
    blocks: [
      {
        kind: frameKind === 'session_status' ? 'status' : 'markdown',
        text: message.body,
        ...(frameKind === 'session_status' ? { status: message.phase } : {}),
        payload: {
          messageId: message.messageId,
          kind: message.kind,
          phase: message.phase,
          execution: message.execution,
        },
      },
    ],
    actions: [],
    ...(message.execution.runId !== undefined ? { runId: message.execution.runId } : {}),
    ts: message.createdAt,
  }
}

function messageContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const direct =
    stringField(payload, 'text') ??
    stringField(payload, 'content') ??
    stringField(payload, 'message') ??
    stringField(payload, 'prompt') ??
    stringField(payload, 'summary') ??
    stringField(payload, 'output')
  if (direct !== undefined) return direct

  const message = payload['message']
  if (isRecord(message)) {
    const content = message['content']
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? stringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return undefined
}

function toolText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const input = payload['input']
  if (isRecord(input)) return JSON.stringify(input)
  const result = payload['result']
  if (isRecord(result)) {
    const content = result['content']
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? stringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return (
    stringField(payload, 'command') ?? stringField(payload, 'cmd') ?? stringField(payload, 'output')
  )
}

function toolStatus(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  if (typeof payload['isError'] === 'boolean')
    return payload['isError'] === true ? 'error' : 'success'
  return stringField(payload, 'status') ?? stringField(payload, 'state') ?? fallback
}

function projectPrimaryEvent(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame | undefined {
  if (event.errorCode !== undefined) {
    return projectFrame(event, mode)
  }

  const base = {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }

  switch (event.eventKind) {
    case 'turn.user_prompt': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      const trimmed = text.trim()
      if (
        trimmed === 'cody' ||
        trimmed.startsWith('You are Cody,') ||
        trimmed.startsWith('[DM #')
      ) {
        return undefined
      }
      return {
        ...base,
        frameKind: 'user_prompt',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.message': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      return {
        ...base,
        frameKind: 'assistant_message',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.tool_call': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_call',
        blocks: [
          {
            kind: 'tool_call',
            text: toolText(event.payload),
            toolName: stringField(payload, 'toolName') ?? stringField(payload, 'tool'),
            toolUseId: stringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'running'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'turn.tool_result': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_result',
        blocks: [
          {
            kind: 'tool_result',
            text: toolText(event.payload),
            toolName: stringField(payload, 'toolName') ?? stringField(payload, 'tool'),
            toolUseId: stringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'success'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'runtime.interrupted':
      return {
        ...base,
        frameKind: 'turn_status',
        blocks: [
          {
            kind: 'status',
            text: 'Turn interrupted',
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'runtime.stale':
    case 'context.cleared':
      return {
        ...base,
        frameKind: 'session_status',
        blocks: [
          {
            kind: 'status',
            text: frameText(event),
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'launch.exited': {
      const payload = isRecord(event.payload) ? event.payload : {}
      const exitCode = numberField(payload, 'exitCode')
      if (exitCode === undefined || exitCode === 0) return undefined
      return {
        ...base,
        frameKind: 'error',
        blocks: [
          {
            kind: 'status',
            text: `Launch exited with code ${exitCode}`,
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    }
    default:
      return undefined
  }
}

function inputTimestamp(input: TimelineInput): string {
  return input.kind === 'event' ? input.event.ts : input.message.createdAt
}

function inputSeq(input: TimelineInput): number {
  return input.kind === 'event' ? input.event.hrcSeq : input.message.messageSeq
}

function sortInputs(lhs: TimelineInput, rhs: TimelineInput): number {
  const byTime = inputTimestamp(lhs).localeCompare(inputTimestamp(rhs))
  if (byTime !== 0) return byTime
  return inputSeq(lhs) - inputSeq(rhs)
}

function resequenceFrames(frames: MobileTimelineFrame[]): MobileTimelineFrame[] {
  return frames.map((frame, index) => ({ ...frame, frameSeq: index + 1 }))
}

function historyPage(
  events: HrcLifecycleEvent[],
  messages: HrcMessageRecord[],
  raw: boolean,
  fallbackSessionRef?: string
): MobileHistoryPage {
  const sorted = [...events].sort((lhs, rhs) => lhs.hrcSeq - rhs.hrcSeq)
  const sortedMessages = [...messages].sort((lhs, rhs) => lhs.messageSeq - rhs.messageSeq)
  const oldest = sorted[0]?.hrcSeq ?? 0
  const newest = sorted[sorted.length - 1]?.hrcSeq ?? 0
  const oldestMessage = sortedMessages[0]?.messageSeq ?? 0
  const newestMessage = sortedMessages[sortedMessages.length - 1]?.messageSeq ?? 0
  const inputs: TimelineInput[] = [
    ...sorted.map((event) => ({ kind: 'event' as const, event })),
    ...sortedMessages.map((message) => ({ kind: 'message' as const, message })),
  ].sort(sortInputs)
  const frames = inputs
    .map((input) =>
      input.kind === 'event'
        ? raw
          ? projectFrame(input.event)
          : projectPrimaryEvent(input.event)
        : projectMessage(input.message, fallbackSessionRef)
    )
    .filter((frame): frame is MobileTimelineFrame => frame !== undefined)

  return {
    frames: resequenceFrames(frames),
    oldestCursor: { hrcSeq: oldest, messageSeq: oldestMessage },
    newestCursor: { hrcSeq: newest, messageSeq: newestMessage },
    hasMoreBefore: false,
    ...(raw ? { events: sorted.map(projectEvent) } : {}),
  }
}

async function resolveMobileSession(
  hrcClient: AcpHrcClient,
  sessionRefValue: string
): Promise<{
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
}> {
  const records = await hrcClient.listSessions({})
  const record = records.find(
    (candidate) => sessionRef(candidate.scopeRef, candidate.laneRef) === sessionRefValue
  )
  if (record === undefined) {
    badRequest(`session not found: ${sessionRefValue}`, { sessionRef: sessionRefValue })
  }
  const runtimes = await hrcClient.listRuntimes({ hostSessionId: record.hostSessionId })
  return { record, runtime: latestRuntimeForSession(record, runtimes) }
}

function eventOptionsFromURL(url: URL): Parameters<AcpHrcClient['watch']>[0] {
  const fromSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '1', 10)
  const generation = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
  return {
    fromSeq: Number.isFinite(fromSeq) ? Math.max(1, fromSeq) : 1,
    follow: url.searchParams.get('follow') === 'true',
    ...(url.searchParams.get('hostSessionId') !== null
      ? { hostSessionId: url.searchParams.get('hostSessionId') ?? undefined }
      : {}),
    ...(Number.isFinite(generation) ? { generation } : {}),
  }
}

export const handleMobileHealth: RouteHandler = async ({ deps }) => {
  const hrcClient = deps.hrcClient
  let hrcOk = false
  let hrcApiVersion: string | undefined = API_VERSION
  let hrcError: string | undefined

  if (hrcClient === undefined) {
    hrcError = 'hrcClient not configured'
  } else {
    try {
      const health = await hrcClient.getHealth()
      hrcOk = health.ok === true
    } catch (error) {
      hrcError = error instanceof Error ? error.message : String(error)
      hrcApiVersion = undefined
    }
  }

  const capabilities = {
    sessions: hrcClient !== undefined,
    timeline: hrcClient !== undefined,
    diagnostics: hrcClient !== undefined,
    input: hrcClient !== undefined,
    interrupt: hrcClient !== undefined,
    pairing: true,
  }

  return json({
    ok: hrcClient !== undefined && hrcOk,
    gatewayId: GATEWAY_ID,
    apiVersion: API_VERSION,
    hrc: {
      ok: hrcOk,
      ...(hrcApiVersion !== undefined ? { apiVersion: hrcApiVersion } : {}),
      ...(hrcError !== undefined ? { error: hrcError } : {}),
      capabilities: {
        sessions: capabilities.sessions,
        events: capabilities.timeline || capabilities.diagnostics,
        messages: capabilities.timeline,
        literalInput: capabilities.input,
        appOwnedSessions: false,
      },
    },
    capabilities,
  })
}

export const handleMobilePairing: RouteHandler = async () =>
  json({
    version: 1,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL: DEFAULT_BASE_URL,
    capabilities: {
      sessions: true,
      timeline: true,
      diagnostics: true,
      input: true,
      interrupt: true,
    },
  })

export const handleMobilePair: RouteHandler = async ({ request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const baseURL = readOptionalTrimmedStringField(body, 'baseURL') ?? DEFAULT_BASE_URL
  return json({
    ok: true,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL,
    pairedAt: new Date().toISOString(),
  })
}

export const handleMobileSessions: RouteHandler = async ({ deps, url }) =>
  json(await listMobileSessions(deps, url))

export const handleMobileHistory: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '80', 10)
  const raw = url.searchParams.get('raw') === 'true'
  const parsedLimit = Number.isFinite(limit) ? limit : 80
  const generation = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
  const beforeMessageSeq = Number.parseInt(url.searchParams.get('beforeMessageSeq') ?? '', 10)
  const sessionRefValue = url.searchParams.get('sessionRef') ?? undefined
  const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
  const [events, messages] = await Promise.all([
    collectEvents(hrcClient, eventOptionsFromURL(url), parsedLimit),
    collectMessages(hrcClient, {
      sessionRef: sessionRefValue,
      hostSessionId,
      ...(Number.isFinite(generation) ? { generation } : {}),
      ...(Number.isFinite(beforeMessageSeq) ? { beforeMessageSeq } : {}),
      limit: parsedLimit,
    }),
  ])
  return json(historyPage(events, messages, raw, sessionRefValue))
}

export const handleMobileInput: RouteHandler = async ({ deps, request }) => {
  const hrcClient = requireHrcClient(deps)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')
  const text = requireTrimmedStringField(body, 'text')
  const sessionRefValue = requireTrimmedStringField(body, 'sessionRef')

  try {
    await hrcClient.deliverLiteralBySelector({
      selector: { sessionRef: sessionRefValue },
      text,
      enter: body['enter'] !== false,
      ...(typeof body['fences'] === 'object' && body['fences'] !== null
        ? { fences: body['fences'] as never }
        : {}),
    })
    return json({ ok: true, clientInputId, acceptedAt: new Date().toISOString() })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'input_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}

export const handleMobileInterrupt: RouteHandler = async ({ deps, request }) => {
  const hrcClient = requireHrcClient(deps)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')
  const sessionRefValue = requireTrimmedStringField(body, 'sessionRef')

  try {
    const { runtime } = await resolveMobileSession(hrcClient, sessionRefValue)
    if (runtime === undefined) {
      return json(
        { ok: false, clientInputId, code: 'not_interruptible', message: 'No runtime is attached.' },
        422
      )
    }
    await hrcClient.interrupt(runtime.runtimeId)
    return json({ ok: true, clientInputId })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'interrupt_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}

export async function openMobileWebSocket(ws: MobileWebSocket): Promise<void> {
  const { deps, url, kind, abortController } = ws.data
  const hrcClient = requireHrcClient(deps)
  const parsedURL = new URL(url)
  const sessionRefValue = parsedURL.searchParams.get('sessionRef') ?? undefined
  const generation = Number.parseInt(parsedURL.searchParams.get('generation') ?? '', 10)
  const fromMessageSeq = Number.parseInt(parsedURL.searchParams.get('fromMessageSeq') ?? '0', 10)
  const raw = parsedURL.searchParams.get('raw') === 'true'
  const options = {
    ...eventOptionsFromURL(parsedURL),
    follow: true,
    signal: abortController.signal,
  }
  let liveFrameSeq = 1

  if (kind === 'timeline') {
    const index = await listMobileSessions(deps, parsedURL)
    const session = index.sessions[0]
    const [historyEvents, historyMessages] = await Promise.all([
      collectEvents(hrcClient, { ...options, fromSeq: 1, follow: false }, 80),
      collectMessages(hrcClient, {
        sessionRef: session?.sessionRef ?? sessionRefValue,
        hostSessionId: options.hostSessionId,
        ...(Number.isFinite(generation) ? { generation } : {}),
        limit: 80,
      }),
    ])
    const history = historyPage(
      historyEvents,
      historyMessages,
      raw,
      session?.sessionRef ?? sessionRefValue
    )
    liveFrameSeq = (history.frames.at(-1)?.frameSeq ?? 0) + 1
    if (session !== undefined) {
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          session,
          snapshotHighWater: history.newestCursor,
          history,
        })
      )
    }
  }

  try {
    if (kind === 'diagnostics') {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        ws.send(JSON.stringify(projectEvent(event)))
      }
      return
    }

    const sendFrame = (frame: MobileTimelineFrame | undefined): void => {
      if (frame === undefined || abortController.signal.aborted) return
      ws.send(JSON.stringify({ type: 'frame', frame: { ...frame, frameSeq: liveFrameSeq++ } }))
    }

    const pumpEvents = async (): Promise<void> => {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        sendFrame(raw ? projectFrame(event) : projectPrimaryEvent(event))
        if (raw) ws.send(JSON.stringify(projectEvent(event)))
      }
    }

    const pumpMessages = async (): Promise<void> => {
      for await (const message of hrcClient.watchMessages({
        filter: {
          ...(options.hostSessionId !== undefined ? { hostSessionId: options.hostSessionId } : {}),
          ...(Number.isFinite(generation) ? { generation } : {}),
          ...(Number.isFinite(fromMessageSeq) ? { afterSeq: fromMessageSeq } : {}),
          order: 'asc',
        },
        follow: true,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted) break
        const sessionRefForFrame = sessionRefValue
        if (
          sessionRefForFrame !== undefined &&
          message.execution.sessionRef !== undefined &&
          message.execution.sessionRef !== sessionRefForFrame
        ) {
          continue
        }
        sendFrame(projectMessage(message, sessionRefForFrame))
      }
    }

    await Promise.all([pumpEvents(), pumpMessages()])
  } catch (error) {
    if (!abortController.signal.aborted) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'mobile_stream_failed',
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }
}

export function closeMobileWebSocket(ws: MobileWebSocket): void {
  try {
    ws.data.abortController.abort()
  } catch {
    // The socket is already closing; abort errors are expected during teardown.
  }
}
