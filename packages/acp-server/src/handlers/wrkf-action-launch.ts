import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import { normalizeSessionRef, parseSessionRef } from 'agent-scope'

import { AcpHttpError, json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { launchAction } from '../wrkf/action-launch.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'

const COMMAND_MATERIAL_FIELDS = ['command', 'argv', 'cwd', 'env'] as const

/**
 * Node D2 (contract C-0010): authorized HTTP transport for the FROZEN
 * action-launch adapter at `POST /v1/wrkf/actions/launch`.
 *
 * Unlike the Node F route (`/v1/workflow-action-runs`), this route is wrapped by
 * the standard ACP actor/authz middleware (see mutating-routes.ts), so the
 * authorized actor arrives on `context.actor` rather than being hand-parsed from
 * the body. The handler is transport-only: validate/normalize input, call
 * `launchAction(deps, input)`, map adapter errors to HTTP status, and return the
 * `WrkfActionLaunchResult` unchanged. The adapter logic is FROZEN.
 *
 * Strict guards (C-0010 non-goals): the handler holds NO action ledger, writes
 * NO task scalar truth (`cp_*`, `session_id`, `sdk_session_id`, `run_status`),
 * and NEVER reads client-supplied `externalRunRef` / `hrcRunId` — those are
 * adapter results, not UI authority. Only the whitelisted request fields are
 * forwarded to the adapter; any client-supplied `externalRunRef` / `hrcRunId`
 * are silently ignored.
 */
export const handleLaunchWrkfAction: RouteHandler = async ({ request, deps, actor }) => {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  if (deps.launchRoleScopedRun === undefined) {
    throw new AcpHttpError(503, 'HRC_LAUNCHER_UNAVAILABLE', 'HRC runtime launcher not available')
  }

  const body = requireRecord(await parseJsonBody(request))
  const taskId = requireTrimmedStringField(body, 'taskId')
  const action = requireTrimmedStringField(body, 'action')
  if (isServerConfiguredCommandAction(action)) {
    rejectCommandMaterial(body, action)
  }
  const role = readOptionalTrimmedStringField(body, 'role')
  rejectUntrustedCommandRole(action, role)
  const lane = readOptionalTrimmedStringField(body, 'lane')
  const initialPrompt = readOptionalTrimmedStringField(body, 'initialPrompt')
  // The authorized actor flows from the actor/authz middleware, not the raw body.
  const resolvedActor = actor ?? deps.defaultActor
  const sessionRef = parseActionSessionRef(body, resolvedActor)
  if (sessionRef === undefined) {
    // No launchable triager target: the request supplied no sessionRef/scopeRef and
    // the resolved actor is not a real agent (a kind:'system'/default identity such
    // as `acp-local` cannot run a worker). Reject BEFORE wrkf.action.start so no
    // action run is created (T-05039, daedalus ruling DM #9631).
    throw new AcpHttpError(
      422,
      'launch_target_required',
      'no launchable triager target: provide a sessionRef (launch intent) or call as an agent actor — a system/default actor cannot run a worker'
    )
  }

  try {
    const result = await launchAction(
      {
        wrkf,
        runStore: deps.runStore,
        launchRoleScopedRun: deps.launchRoleScopedRun,
        ...(deps.launchCommandScopedRun !== undefined
          ? { launchCommandScopedRun: deps.launchCommandScopedRun }
          : {}),
        ...(deps.triageCommandTargetId !== undefined
          ? { triageCommandTargetId: deps.triageCommandTargetId }
          : {}),
        ...(deps.implCommandTargetId !== undefined
          ? { implCommandTargetId: deps.implCommandTargetId }
          : {}),
        ...(deps.verifyCommandTargetId !== undefined
          ? { verifyCommandTargetId: deps.verifyCommandTargetId }
          : {}),
        ...(deps.runtimeResolver !== undefined ? { runtimeResolver: deps.runtimeResolver } : {}),
        ...(deps.agentRootResolver !== undefined
          ? { agentRootResolver: deps.agentRootResolver }
          : {}),
        ...(deps.adminStore !== undefined ? { adminStore: deps.adminStore } : {}),
      },
      {
        taskId,
        action,
        ...(role !== undefined ? { role } : {}),
        ...(lane !== undefined ? { lane } : {}),
        ...(resolvedActor !== undefined ? { actor: resolvedActor } : {}),
        idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
        sessionRef,
        ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      }
    )

    return json(result, result.replay ? 200 : 201)
  } catch (error) {
    throw mapWrkfError(error)
  }
}

function isServerConfiguredCommandAction(action: string): boolean {
  return action === 'triage' || action === 'implement' || action === 'verify'
}

function rejectCommandMaterial(body: Record<string, unknown>, action: string): void {
  for (const field of COMMAND_MATERIAL_FIELDS) {
    if (body[field] !== undefined) {
      throw new AcpHttpError(
        400,
        'client_command_material_rejected',
        `client-supplied ${field} is not accepted for action:"${action}"; the command target is server-configured`
      )
    }
  }
}

function rejectUntrustedCommandRole(action: string, role: string | undefined): void {
  const expectedRole =
    action === 'implement' ? 'implementer' : action === 'verify' ? 'tester' : undefined
  if (expectedRole !== undefined && role !== undefined && role !== expectedRole) {
    throw new AcpHttpError(
      400,
      'client_command_role_rejected',
      `client-supplied role is not accepted for action:"${action}"; expected "${expectedRole}"`
    )
  }
}

function parseActionSessionRef(
  body: Record<string, unknown>,
  actor: Actor | undefined
): SessionRef | undefined {
  const sessionRef = body['sessionRef']
  if (typeof sessionRef === 'string' && sessionRef.trim().length > 0) {
    return parseSessionRefString(sessionRef)
  }
  if (sessionRef !== undefined) {
    const raw = requireRecord(sessionRef, 'sessionRef')
    const laneRef = readOptionalTrimmedStringField(raw, 'laneRef')
    return normalizeSessionRef({
      scopeRef: requireTrimmedStringField(raw, 'scopeRef'),
      ...(laneRef !== undefined ? { laneRef } : {}),
    })
  }

  const scopeRef = readOptionalTrimmedStringField(body, 'scopeRef')
  if (scopeRef !== undefined) {
    return normalizeSessionRef({
      scopeRef,
      laneRef: readOptionalTrimmedStringField(body, 'laneRef') ?? 'main',
    })
  }

  // No explicit launch target on the request. The ONLY safe implicit target is a
  // real agent actor (the UI launch-intent path always supplies an explicit
  // sessionRef; an agent-scoped service call may rely on its own actor). A
  // kind:'system'/default actor (e.g. `acp-local`) is a run/job-owner identity with
  // no launchable agent profile — defaulting a worker to it strands an active action
  // and 500s on the missing profile (T-05039). Return undefined so the handler can
  // reject with a typed 422 BEFORE wrkf.action.start.
  if (actor?.kind === 'agent') {
    return normalizeSessionRef({ scopeRef: `agent:${actor.id}`, laneRef: 'main' })
  }
  return undefined
}

function parseSessionRefString(input: string) {
  const trimmed = input.trim()
  const shorthandIndex = trimmed.lastIndexOf('~')
  if (shorthandIndex > 0) {
    return normalizeSessionRef({
      scopeRef: trimmed.slice(0, shorthandIndex),
      laneRef: trimmed.slice(shorthandIndex + 1),
    })
  }
  return parseSessionRef(trimmed)
}

function mapWrkfError(error: unknown): unknown {
  if (isWrkfError(error)) {
    return new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
  }
  return error
}

function isWrkfError(error: unknown): error is Error & { code: string } {
  const candidate = error as { code?: unknown }
  return error instanceof Error && typeof candidate.code === 'string' && candidate.code.length > 0
}
