import { HrcDomainError, HrcErrorCode, httpStatusForErrorCode, validateFence } from 'hrc-core'
import type {
  DeliverLiteralBySelectorRequest,
  DeliverLiteralBySelectorResponse,
  HrcAppSessionRef,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  InterruptAppSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { InputRequest, InterruptRequest, MobileFence } from './contracts.js'

type JsonObject = Record<string, unknown>

export type GatewayIosHrcClient = Pick<
  HrcClient,
  'deliverLiteralBySelector' | 'interrupt' | 'listRuntimes' | 'resolveSession'
> & {
  interruptAppSession?: (request: InterruptAppSessionRequest) => Promise<RuntimeActionResponse>
  postJson?: <T>(path: string, body: unknown) => Promise<T>
}

export type InputHandlerDeps = {
  hrcClient: GatewayIosHrcClient
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorJson(code: string, status: number, message?: string | undefined): Response {
  return json(
    {
      ok: false,
      code,
      ...(message !== undefined ? { message } : {}),
    },
    status
  )
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFenceObject(value: unknown): MobileFence {
  if (value === undefined) return {}
  if (!isJsonObject(value)) {
    throw new HrcDomainError(HrcErrorCode.INVALID_FENCE, 'fences must be an object')
  }

  const fence: MobileFence = {}
  const expectedHostSessionId = value['expectedHostSessionId']
  const expectedGeneration = value['expectedGeneration']
  if (expectedHostSessionId !== undefined) {
    if (typeof expectedHostSessionId !== 'string') {
      throw new HrcDomainError(HrcErrorCode.INVALID_FENCE, 'expectedHostSessionId must be a string')
    }
    fence.expectedHostSessionId = expectedHostSessionId
  }
  if (expectedGeneration !== undefined) {
    if (typeof expectedGeneration !== 'number') {
      throw new HrcDomainError(HrcErrorCode.INVALID_FENCE, 'expectedGeneration must be a number')
    }
    fence.expectedGeneration = expectedGeneration
  }
  return fence
}

async function parseJsonBody(request: Request): Promise<JsonObject> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be valid JSON')
  }

  if (!isJsonObject(body)) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  return body
}

async function parseInputRequest(request: Request): Promise<InputRequest> {
  const body = await parseJsonBody(request)
  const sessionRef = body['sessionRef']
  const clientInputId = body['clientInputId']
  const text = body['text']
  const enter = body['enter']
  const fences = body['fences']

  if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required')
  }
  if (typeof clientInputId !== 'string' || clientInputId.length === 0) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'clientInputId is required')
  }
  if (typeof text !== 'string') {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'text is required')
  }
  if (enter !== undefined && typeof enter !== 'boolean') {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'enter must be a boolean')
  }

  return {
    sessionRef,
    clientInputId,
    text,
    enter: enter === true,
    fences: parseFenceObject(fences),
  }
}

async function parseInterruptRequest(request: Request): Promise<InterruptRequest> {
  const body = await parseJsonBody(request)
  const sessionRef = body['sessionRef']
  const clientInputId = body['clientInputId']
  const fences = body['fences']

  if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required')
  }
  if (typeof clientInputId !== 'string' || clientInputId.length === 0) {
    throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'clientInputId is required')
  }

  return {
    sessionRef,
    clientInputId,
    fences: parseFenceObject(fences),
  }
}

function sessionRecord(resolved: ResolveSessionResponse): HrcSessionRecord {
  return resolved.session
}

function explicitMode(resolved: ResolveSessionResponse): string | undefined {
  const responseMode = (resolved as unknown as { mode?: unknown }).mode
  if (typeof responseMode === 'string') return responseMode

  const sessionMode = (resolved.session as unknown as { mode?: unknown; executionMode?: unknown })
    .mode
  if (typeof sessionMode === 'string') return sessionMode

  const executionMode = (resolved.session as unknown as { executionMode?: unknown }).executionMode
  return typeof executionMode === 'string' ? executionMode : undefined
}

function isInteractiveSession(resolved: ResolveSessionResponse): boolean {
  const mode = explicitMode(resolved)
  if (mode === 'interactive') return true
  if (mode === 'headless' || mode === 'nonInteractive') return false

  const intent = resolved.session.lastAppliedIntentJson
  if (intent?.harness.interactive === false) return false
  if (intent?.harness.interactive === true) return true
  if (
    intent?.execution?.preferredMode === 'headless' ||
    intent?.execution?.preferredMode === 'nonInteractive'
  ) {
    return false
  }

  return true
}

function validateSessionFence(
  resolved: ResolveSessionResponse,
  fences: MobileFence
): Response | null {
  const result = validateFence(fences, {
    activeHostSessionId: resolved.hostSessionId,
    generation: resolved.generation,
  })

  if (result.ok) return null
  return errorJson(result.errorCode, httpStatusForErrorCode(result.errorCode), result.message)
}

function appSessionSelectorFor(session: HrcSessionRecord): HrcAppSessionRef | null {
  const explicit = session as unknown as {
    appSession?: HrcAppSessionRef | undefined
    appId?: string | undefined
    appSessionKey?: string | undefined
  }
  if (explicit.appSession) return explicit.appSession
  if (explicit.appId && explicit.appSessionKey) {
    return { appId: explicit.appId, appSessionKey: explicit.appSessionKey }
  }
  if (session.scopeRef.startsWith('app:')) {
    return { appId: session.scopeRef.slice('app:'.length), appSessionKey: session.laneRef }
  }
  return null
}

function latestRuntimeForSession(runtimes: HrcRuntimeSnapshot[]): HrcRuntimeSnapshot | undefined {
  const alive = runtimes.filter((runtime) => runtime.status !== 'terminated')
  const candidates = alive.length > 0 ? alive : runtimes
  return candidates.sort((a, b) => {
    const aUpdated = Date.parse((a as unknown as { updatedAt?: string }).updatedAt ?? '')
    const bUpdated = Date.parse((b as unknown as { updatedAt?: string }).updatedAt ?? '')
    return (Number.isNaN(bUpdated) ? 0 : bUpdated) - (Number.isNaN(aUpdated) ? 0 : aUpdated)
  })[0]
}

async function interruptAppSession(
  hrcClient: GatewayIosHrcClient,
  selector: HrcAppSessionRef
): Promise<RuntimeActionResponse> {
  const request: InterruptAppSessionRequest = { selector }
  if (hrcClient.interruptAppSession) {
    return await hrcClient.interruptAppSession(request)
  }
  if (hrcClient.postJson) {
    return await hrcClient.postJson<RuntimeActionResponse>('/v1/app-sessions/interrupt', request)
  }
  throw new HrcDomainError(
    HrcErrorCode.INTERNAL_ERROR,
    'HrcClient cannot call /v1/app-sessions/interrupt'
  )
}

function hrcErrorResponse(error: unknown): Response {
  if (error instanceof HrcDomainError) {
    return errorJson(error.code, error.status, error.message)
  }
  return errorJson(
    HrcErrorCode.INTERNAL_ERROR,
    500,
    error instanceof Error ? error.message : String(error)
  )
}

export async function handleInput(request: Request, deps: InputHandlerDeps): Promise<Response> {
  try {
    const body = await parseInputRequest(request)
    const resolved = await deps.hrcClient.resolveSession({ sessionRef: body.sessionRef })

    if (!isInteractiveSession(resolved)) {
      return errorJson('session_not_interactive', 400)
    }

    const fenceError = validateSessionFence(resolved, body.fences)
    if (fenceError) return fenceError

    const literalRequest: DeliverLiteralBySelectorRequest = {
      selector: { sessionRef: body.sessionRef },
      text: body.text,
      enter: body.enter,
      fences: body.fences,
    }
    await deps.hrcClient.deliverLiteralBySelector(literalRequest)

    return json({
      ok: true,
      clientInputId: body.clientInputId,
      acceptedAt: new Date().toISOString(),
    })
  } catch (error) {
    return hrcErrorResponse(error)
  }
}

export async function handleInterrupt(request: Request, deps: InputHandlerDeps): Promise<Response> {
  try {
    const body = await parseInterruptRequest(request)
    const resolved = await deps.hrcClient.resolveSession({ sessionRef: body.sessionRef })
    const fenceError = validateSessionFence(resolved, body.fences)
    if (fenceError) return fenceError

    const appSelector = appSessionSelectorFor(sessionRecord(resolved))
    if (appSelector) {
      await interruptAppSession(deps.hrcClient, appSelector)
    } else {
      const runtimes = await deps.hrcClient.listRuntimes({ hostSessionId: resolved.hostSessionId })
      const runtime = latestRuntimeForSession(runtimes)
      if (!runtime) {
        return errorJson(HrcErrorCode.RUNTIME_UNAVAILABLE, 503, 'no runtime available')
      }
      await deps.hrcClient.interrupt(runtime.runtimeId)
    }

    return json({ ok: true, clientInputId: body.clientInputId })
  } catch (error) {
    return hrcErrorResponse(error)
  }
}

export type { DeliverLiteralBySelectorResponse }
