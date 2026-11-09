import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { HrcDispatchOrigin, HrcRuntimeIntent } from 'hrc-core'
import type { InputAttemptStore, RunStore } from './deps.js'
import type { JobFirstBirthAuthority } from './jobs/first-birth-authority.js'
import { readRecord, readOptionalString as readString } from './wrkf/value.js'

export function resolveHrcDispatchOrigin(input: {
  inputAttemptStore: InputAttemptStore | undefined
  inputAttemptId: string | undefined
  acpRunId: string | undefined
  runStore: RunStore | undefined
}): HrcDispatchOrigin | undefined {
  if (input.inputAttemptStore !== undefined && input.inputAttemptId !== undefined) {
    const attempt = input.inputAttemptStore.getById(input.inputAttemptId)?.inputAttempt
    if (attempt !== undefined) {
      return hrcDispatchOriginFromActor(attempt.actor, attempt.metadata)
    }
  }

  const run =
    input.runStore !== undefined && input.acpRunId !== undefined
      ? input.runStore.getRun(input.acpRunId)
      : undefined
  if (run === undefined) {
    return undefined
  }

  const runMetadata = readRecord(run.metadata) ?? {}
  return hrcDispatchOriginFromActor(run.actor, readRecord(runMetadata['meta']) ?? {})
}

/**
 * The job run this launch belongs to, only when the jobs store confirms it is
 * live and targets this session. Caller meta alone never qualifies: /v1/inputs
 * passes meta through, so a claimed `source.kind: 'job'` is just a claim.
 */
export function readVerifiedJobRunId(input: {
  inputAttemptStore: InputAttemptStore | undefined
  inputAttemptId: string | undefined
  acpRunId: string | undefined
  runStore: RunStore | undefined
  sessionRef: SessionRef
  authority: JobFirstBirthAuthority | undefined
}): string | undefined {
  if (input.authority === undefined) {
    return undefined
  }
  const attempt =
    input.inputAttemptStore !== undefined && input.inputAttemptId !== undefined
      ? input.inputAttemptStore.getById(input.inputAttemptId)?.inputAttempt
      : undefined
  const run =
    input.runStore !== undefined && input.acpRunId !== undefined
      ? input.runStore.getRun(input.acpRunId)
      : undefined
  const meta =
    attempt !== undefined
      ? (readRecord(attempt.metadata) ?? {})
      : (readRecord(readRecord(run?.metadata)?.['meta']) ?? {})
  const source = readRecord(meta['source']) ?? {}
  const jobRunId = source['kind'] === 'job' ? readString(source, 'jobRunId') : undefined
  if (jobRunId === undefined) {
    return undefined
  }
  return input.authority({ jobRunId, sessionRef: input.sessionRef }) ? jobRunId : undefined
}

function hrcDispatchOriginFromActor(
  actor: Actor,
  metadata: Readonly<Record<string, unknown>> | undefined
): HrcDispatchOrigin {
  const prefix = `${actor.kind}:`
  const source = readRecord(metadata?.['source']) ?? {}
  const jobRunId = source['kind'] === 'job' ? readString(source, 'jobRunId') : undefined

  return {
    actor: actor.id.startsWith(prefix) ? actor.id : `${prefix}${actor.id}`,
    kind: actor.kind,
    ...(jobRunId !== undefined ? { causationRef: jobRunId } : {}),
  }
}

export function withHrcDispatchOrigin<T extends object>(
  request: T,
  origin: HrcDispatchOrigin | undefined
): T & { origin?: HrcDispatchOrigin } {
  return origin === undefined ? request : { ...request, origin }
}

// Env-gated, scope-exact passthrough of HRC's per-request first_turn_missing
// watchdog override (DispatchTurnRequest.firstTurnTimeoutMs, T-07235). Both
// variables must be set and the dispatch scope must match byte-for-byte;
// every other dispatch keeps the fleet's global default. The knob exists only
// in the server environment — unset + restart removes the surface entirely —
// so a drill can shorten one scope's deadline without minting spurious
// first_turn_missing terminal failures on unrelated production dispatches.
export function resolveFirstTurnTimeoutOverrideMs(scopeRef: string): number | undefined {
  const scope = process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE']?.trim()
  if (scope === undefined || scope.length === 0 || scope !== scopeRef) {
    return undefined
  }
  const ms = Number(process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS']?.trim())
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

export function withFirstTurnTimeout<T extends object>(
  request: T,
  firstTurnTimeoutMs: number | undefined
): T & { firstTurnTimeoutMs?: number } {
  return firstTurnTimeoutMs === undefined ? request : { ...request, firstTurnTimeoutMs }
}

export function withAcpLaunchContextEnv(
  intent: HrcRuntimeIntent,
  input: {
    acpRunId?: string | undefined
    inputAttemptId?: string | undefined
    runStore?: RunStore | undefined
  }
): HrcRuntimeIntent {
  const env: Record<string, string> = {}
  if (input.acpRunId !== undefined) {
    env['ACP_RUN_ID'] = input.acpRunId
  }
  if (input.inputAttemptId !== undefined) {
    env['ACP_INPUT_ATTEMPT_ID'] = input.inputAttemptId
  }

  const run =
    input.acpRunId !== undefined && input.runStore !== undefined
      ? input.runStore.getRun(input.acpRunId)
      : undefined
  const interfaceSource = readInterfaceSourceFromRun(run)
  if (interfaceSource !== undefined) {
    env['ACP_INTERFACE_SOURCE'] = JSON.stringify(interfaceSource)
  }

  if (Object.keys(env).length === 0) {
    return intent
  }

  return {
    ...intent,
    launch: {
      ...intent.launch,
      env: {
        ...intent.launch?.env,
        ...env,
      },
    },
  }
}

function readInterfaceSourceFromRun(run: ReturnType<RunStore['getRun']>): unknown | undefined {
  const metadata = readRecord(run?.metadata) ?? {}
  const meta = readRecord(metadata['meta']) ?? {}
  const interfaceSource = meta['interfaceSource']
  return typeof interfaceSource === 'object' &&
    interfaceSource !== null &&
    !Array.isArray(interfaceSource)
    ? interfaceSource
    : undefined
}
