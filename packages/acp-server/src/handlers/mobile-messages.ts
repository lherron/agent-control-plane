import { formatScopeHandle, parseScopeRef } from 'agent-scope'
import {
  type HrcMessageAddress,
  type HrcMessageFilter,
  type HrcTargetView,
  splitSessionRef,
} from 'hrc-core'
import type { CollaborationMessage } from 'wrkq-lib'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { badRequest, json } from '../http.js'
import {
  isRecord,
  parseJsonBody,
  readNonBlankStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { requireHrcClient } from './mobile-hrc.js'
import {
  type MobileWebSocketLike,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from './mobile-ws.js'

const HUMAN_COLLABORATION_PRINCIPAL = 'agent:lance'

type MobileDmTargetsResponse = {
  targets: HrcTargetView[]
}

type MobileMessagesResponse = {
  messages: CollaborationMessage[]
}

async function pollCollaborationMessages(input: {
  deps: ResolvedAcpServerDeps
  selector: { roomKey: string } | { memberRef: string }
  afterMessageSeq: number
  signal: AbortSignal
  onMessage(message: CollaborationMessage): void | Promise<void>
}): Promise<void> {
  const ledger = input.deps.collaborationLedger
  if (ledger === undefined) throw new Error('collaboration ledger is not configured')
  let cursor = input.afterMessageSeq

  const waker = input.deps.commitWaker
  if (waker === undefined) throw new Error('wrkq commit waker is not configured')
  while (!input.signal.aborted) {
    const token = await waker.token()
    const result =
      'roomKey' in input.selector
        ? await ledger.listMessagesByRoom({
            roomKey: input.selector.roomKey,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            limit: 200,
          })
        : await ledger.listMessagesByMember({
            memberRef: input.selector.memberRef,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            limit: 200,
          })
    const fresh = result.messages
      .filter((message) => message.messageSeq > cursor)
      .sort((lhs, rhs) => lhs.messageSeq - rhs.messageSeq)
    for (const message of fresh) {
      await input.onMessage(message)
      cursor = Math.max(cursor, message.messageSeq)
    }
    await waker.wait(token, { signal: input.signal })
  }
}

function addressSessionRef(address: HrcMessageAddress): string | undefined {
  return address.kind === 'session' ? address.sessionRef : undefined
}

function parseMobileMessageAddress(input: unknown, field: string): HrcMessageAddress {
  if (!isRecord(input)) badRequest(`${field} must be an object`)

  const kind = input['kind']
  if (kind === 'entity') {
    const entity = input['entity']
    if (entity !== 'human' && entity !== 'system') {
      badRequest(`${field}.entity must be human or system`)
    }
    return { kind: 'entity', entity }
  }

  if (kind === 'session') {
    const sessionRefValue = input['sessionRef']
    if (typeof sessionRefValue !== 'string' || sessionRefValue.trim().length === 0) {
      badRequest(`${field}.sessionRef is required`)
    }
    return { kind: 'session', sessionRef: sessionRefValue.trim() }
  }

  badRequest(`${field}.kind must be session or entity`)
}

function readPositiveInteger(input: unknown, fallback: number, max: number): number {
  const value = typeof input === 'number' ? input : Number.parseInt(String(input ?? ''), 10)
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(Math.floor(value), max)
}

function readNonNegativeInteger(input: unknown): number | undefined {
  const value = typeof input === 'number' ? input : Number.parseInt(String(input ?? ''), 10)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

function parseMobileMessageFilter(input: Record<string, unknown>): HrcMessageFilter {
  const filter: HrcMessageFilter = {}
  if (input['participant'] !== undefined) {
    filter.participant = parseMobileMessageAddress(input['participant'], 'participant')
  }
  if (input['from'] !== undefined) {
    filter.from = parseMobileMessageAddress(input['from'], 'from')
  }
  if (input['to'] !== undefined) {
    filter.to = parseMobileMessageAddress(input['to'], 'to')
  }
  if (isRecord(input['thread'])) {
    const rootMessageId = input['thread']['rootMessageId']
    if (typeof rootMessageId === 'string' && rootMessageId.trim().length > 0) {
      filter.thread = { rootMessageId: rootMessageId.trim() }
    }
  }
  if (typeof input['hostSessionId'] === 'string' && input['hostSessionId'].trim().length > 0) {
    filter.hostSessionId = input['hostSessionId'].trim()
  }
  const generation = readNonNegativeInteger(input['generation'])
  if (generation !== undefined) filter.generation = generation
  const afterSeq = readNonNegativeInteger(input['afterSeq'])
  if (afterSeq !== undefined) filter.afterSeq = afterSeq
  if (Array.isArray(input['kinds'])) {
    filter.kinds = input['kinds'].filter(
      (kind): kind is 'dm' | 'literal' | 'system' =>
        kind === 'dm' || kind === 'literal' || kind === 'system'
    )
  }
  if (Array.isArray(input['phases'])) {
    filter.phases = input['phases'].filter(
      (phase): phase is 'request' | 'response' | 'oneway' =>
        phase === 'request' || phase === 'response' || phase === 'oneway'
    )
  }
  filter.limit = readPositiveInteger(input['limit'], 50, 200)
  filter.order = input['order'] === 'asc' ? 'asc' : 'desc'

  return filter
}

function collaborationMemberRefFromMobileFilter(
  input: Record<string, unknown>
): string | undefined {
  for (const field of ['participant', 'to', 'from'] as const) {
    if (input[field] === undefined) continue
    const selected = parseMobileMessageAddress(input[field], field)
    const selectedSessionRef = addressSessionRef(selected)
    if (selectedSessionRef !== undefined) {
      return formatScopeHandle(parseScopeRef(splitSessionRef(selectedSessionRef).scopeRef))
    }
  }
  return undefined
}

export const handleMobileMessagesWatch: RouteHandler = async () =>
  json(
    {
      ok: false,
      code: 'upgrade_required',
      message: 'Use a WebSocket upgrade for /v1/mobile/messages/watch.',
    },
    426
  )

export const handleMobileDmTargets: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  const q = url.searchParams.get('q')?.trim().toLowerCase()
  const projectId = url.searchParams.get('projectId') ?? undefined
  const lane = url.searchParams.get('lane') ?? undefined
  const discover = url.searchParams.get('discover') !== 'false'
  let targets = await hrcClient.listTargets({ projectId, lane, discover })

  if (q !== undefined && q.length > 0) {
    targets = targets.filter((target) =>
      [
        target.sessionRef,
        target.scopeRef,
        target.laneRef,
        target.state,
        target.runtime?.runtimeId ?? '',
        target.runtime?.status ?? '',
        target.runtime?.transport ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }

  return json({ targets } satisfies MobileDmTargetsResponse)
}

export const handleMobileMessagesQuery: RouteHandler = async ({ deps, request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const filter = parseMobileMessageFilter(body)
  const roomKey = readNonBlankStringField(body, 'roomKey')
  const memberRef = collaborationMemberRefFromMobileFilter(body)
  const beforeMessageSeq = readNonNegativeInteger(body['beforeMessageSeq'])
  const limit = filter.limit ?? 50
  const collaborationPromise =
    deps.collaborationLedger === undefined
      ? Promise.resolve({ messages: [] as CollaborationMessage[] })
      : roomKey !== undefined
        ? deps.collaborationLedger.listMessagesByRoom({
            roomKey,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            ...(beforeMessageSeq !== undefined ? { beforeMessageSeq } : {}),
            limit,
          })
        : memberRef !== undefined
          ? deps.collaborationLedger.listMessagesByMember({
              memberRef,
              presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
              ...(beforeMessageSeq !== undefined ? { beforeMessageSeq } : {}),
              limit,
            })
          : Promise.resolve({ messages: [] as CollaborationMessage[] })
  const collaboration = await collaborationPromise
  const messages = collaboration.messages
    .sort((lhs, rhs) => {
      const byTime =
        filter.order === 'asc'
          ? lhs.createdAt.localeCompare(rhs.createdAt)
          : rhs.createdAt.localeCompare(lhs.createdAt)
      return byTime !== 0
        ? byTime
        : filter.order === 'asc'
          ? lhs.messageSeq - rhs.messageSeq
          : rhs.messageSeq - lhs.messageSeq
    })
    .slice(0, limit)
  return json({ messages } satisfies MobileMessagesResponse)
}

export const handleMobileSemanticDm: RouteHandler = async ({ deps, request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const text = requireTrimmedStringField(body, 'body')
  const to = parseMobileMessageAddress(body['to'], 'to')
  const replyToMessageId =
    typeof body['replyToMessageId'] === 'string' && body['replyToMessageId'].trim().length > 0
      ? body['replyToMessageId'].trim()
      : undefined
  const targetSessionRef = addressSessionRef(to)
  if (targetSessionRef === undefined) {
    badRequest('mobile human collaboration sends require to.kind=session')
  }
  const targetScopeHandle = formatScopeHandle(
    parseScopeRef(splitSessionRef(targetSessionRef).scopeRef)
  )
  const roomKey = readNonBlankStringField(body, 'roomKey') ?? targetScopeHandle

  if (deps.collaborationLedgerForPrincipal === undefined) {
    throw new Error('collaboration ledger is not configured')
  }
  const humanLedger = await deps.collaborationLedgerForPrincipal(HUMAN_COLLABORATION_PRINCIPAL)
  const collaboration = await humanLedger.say({
    ref: roomKey,
    to: [targetScopeHandle],
    body: text,
    ...(replyToMessageId !== undefined ? { respondTo: replyToMessageId } : {}),
    ...(readNonBlankStringField(body, 'idempotencyKey') !== undefined
      ? { idempotencyKey: readNonBlankStringField(body, 'idempotencyKey') }
      : {}),
  })

  return json({ collaboration })
}

export async function openMobileMessagesWebSocket(
  ws: MobileWebSocketLike,
  parsedURL: URL
): Promise<void> {
  const { deps, abortController } = ws.data
  const filterInput = Object.fromEntries(parsedURL.searchParams.entries()) as Record<
    string,
    unknown
  >
  const afterSeq = readNonNegativeInteger(parsedURL.searchParams.get('afterSeq'))
  const roomKey = readNonBlankStringField(filterInput, 'roomKey')
  const memberRef = collaborationMemberRefFromMobileFilter(filterInput)
  if (roomKey === undefined && memberRef === undefined) {
    sendMobileErrorEnvelope(ws, 'invalid_filter', 'roomKey or a session participant is required')
    ws.close(1008, 'missing collaboration selector')
    return
  }
  await pollCollaborationMessages({
    deps,
    selector: roomKey !== undefined ? { roomKey } : { memberRef: memberRef as string },
    afterMessageSeq: afterSeq ?? 0,
    signal: abortController.signal,
    onMessage: (message) => {
      sendMobileJsonEnvelope(ws, { type: 'message', message })
    },
  })
}
