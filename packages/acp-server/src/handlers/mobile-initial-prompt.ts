import { writeLogLine } from 'acp-core'
import { HrcDomainError } from 'hrc-core'

import type { AcpHrcClient } from '../deps.js'
import { resolveHrcRoutes } from '../hrc-client.js'
import type { HrcRouteReader } from '../hrc-route-reader.js'
import { badRequest } from '../http.js'

export function parseMobileInitialPrompt(body: Record<string, unknown>): string | undefined {
  const value = body['initialPrompt']
  if (value === undefined) return undefined
  if (typeof value !== 'string')
    badRequest('initialPrompt must be a string', { field: 'initialPrompt' })
  const prompt = value.trim()
  if (Buffer.byteLength(prompt, 'utf8') > 16 * 1024) {
    badRequest('initialPrompt must be at most 16 KiB in UTF-8', { field: 'initialPrompt' })
  }
  return prompt || undefined
}

type InitialPromptDelivery =
  | { delivered: true; idempotencyKey: string }
  | { delivered: false; reason: string }

async function isFreshRuntime(
  deps: { hrcRoutes?: HrcRouteReader | undefined },
  target: { hostSessionId: string; runtimeId: string },
  receivedAt: string
): Promise<boolean> {
  try {
    const routes = resolveHrcRoutes(deps, 'acp-server:mobile-initial-prompt')
    const rows = await routes.readRuntimes(target)
    const row = rows.find(
      (candidate) =>
        candidate.runtimeId === target.runtimeId && candidate.hostSessionId === target.hostSessionId
    )
    return row?.createdAt !== undefined && Date.parse(row.createdAt) >= Date.parse(receivedAt)
  } catch {
    return false
  }
}

export async function deliverMobileInitialPrompt(input: {
  deps: { hrcRoutes?: HrcRouteReader | undefined }
  hrc: AcpHrcClient
  initialPrompt: string
  requestId: string
  receivedAt: string
  idempotencyKey: string
  sessionRef: string
  hostSessionId: string
  runtimeId: string | undefined
  replayed: boolean
}): Promise<InitialPromptDelivery> {
  if (
    input.replayed ||
    input.runtimeId === undefined ||
    !(await isFreshRuntime(
      input.deps,
      { hostSessionId: input.hostSessionId, runtimeId: input.runtimeId },
      input.receivedAt
    ))
  ) {
    return { delivered: false, reason: 'runtime_not_fresh' }
  }
  const idempotencyKey = `${input.idempotencyKey}:initial-prompt`
  try {
    const reply = await input.hrc.steer({
      target: input.sessionRef,
      body: input.initialPrompt,
      origin: { principalRef: 'agent:lance' },
      idempotencyKey,
    })
    const disposition = reply.disposition
    const type = disposition?.type
    if (disposition?.type === 'rejected' || disposition?.type === 'lost') {
      return { delivered: false, reason: reply.reason ?? disposition.reason }
    }
    if (type === 'expired' || type === 'cancelled') {
      return { delivered: false, reason: reply.reason ?? type }
    }
    if (reply.admission !== 'admitted') {
      return { delivered: false, reason: reply.reason ?? 'steer_failed' }
    }
  } catch (error) {
    return {
      delivered: false,
      reason: error instanceof HrcDomainError ? error.code : 'steer_failed',
    }
  }

  writeLogLine({
    level: 'info',
    component: 'mobile',
    event: 'mobile.session.initial_prompt_delivered',
    data: {
      requestId: input.requestId,
      sessionRef: input.sessionRef,
      promptBytes: Buffer.byteLength(input.initialPrompt, 'utf8'),
    },
  })
  return { delivered: true, idempotencyKey }
}
