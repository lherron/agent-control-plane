import { CliUsageError } from '../cli-runtime.js'
import { normalizeScopeInput } from '../scope-input.js'
import { type ParsedArgs, readStringFlag, requireStringFlag } from './options.js'

import { type CommandDependencies, createRawRequesterFromParsed } from './shared.js'

function normalizeSessionInput(
  scopeInput: string,
  laneRef?: string
): {
  scopeRef: string
  laneRef?: string | undefined
} {
  try {
    return normalizeScopeInput(scopeInput, laneRef)
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}

export function readSessionRefFlags(
  parsed: ParsedArgs,
  options: {
    scopeFlag?: string | undefined
    laneFlag?: string | undefined
    required?: boolean | undefined
  } = {}
): { scopeRef: string; laneRef?: string | undefined } | undefined {
  const scopeFlag = options.scopeFlag ?? '--scope-ref'
  const laneFlag = options.laneFlag ?? '--lane-ref'
  const rawScope = readStringFlag(parsed, scopeFlag)

  if (rawScope === undefined) {
    if (options.required) {
      throw new CliUsageError(`${scopeFlag} is required`)
    }
    return undefined
  }

  return normalizeSessionInput(rawScope, readStringFlag(parsed, laneFlag))
}

export function requireSessionRefFlags(
  parsed: ParsedArgs,
  options: {
    scopeFlag?: string | undefined
    laneFlag?: string | undefined
  } = {}
): { scopeRef: string; laneRef?: string | undefined } {
  const sessionRef = readSessionRefFlags(parsed, { ...options, required: true })
  if (sessionRef === undefined) {
    throw new CliUsageError(`${options.scopeFlag ?? '--scope-ref'} is required`)
  }
  return sessionRef
}

export async function resolveConcreteSessionId(
  parsed: ParsedArgs,
  deps: CommandDependencies,
  options: {
    sessionFlag?: string | undefined
    scopeFlag?: string | undefined
    laneFlag?: string | undefined
  } = {}
): Promise<string> {
  const sessionFlag = options.sessionFlag ?? '--session'
  const rawSessionId = readStringFlag(parsed, sessionFlag)?.trim()
  const hasScopeRef = readStringFlag(parsed, options.scopeFlag ?? '--scope-ref') !== undefined

  if (rawSessionId && hasScopeRef) {
    throw new CliUsageError(
      `${sessionFlag} cannot be combined with ${options.scopeFlag ?? '--scope-ref'}`
    )
  }

  if (rawSessionId && rawSessionId.length > 0) {
    return rawSessionId
  }

  const sessionRef = requireSessionRefFlags(parsed, options)
  const requester = createRawRequesterFromParsed(parsed, deps)
  const resolved = await requester.requestJson<{ sessionId: string }>({
    method: 'POST',
    path: '/v1/sessions/resolve',
    body: { sessionRef },
  })

  return resolved.sessionId
}

export function requireMessageText(parsed: ParsedArgs, flag = '--text'): string {
  const value = requireStringFlag(parsed, flag)
  if (value.trim().length === 0) {
    throw new CliUsageError(`${flag} is required`)
  }
  return value
}
