import { WorkRpcError } from '@wrkq/client'
import { ActorValidationError } from 'acp-core'
import { InputAttemptConflictError } from 'acp-state-store'
import { HrcDomainError } from 'hrc-core'

export type AcpErrorBody = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown> | undefined
  }
}

export class AcpHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown> | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message)
    this.name = 'AcpHttpError'
    this.status = status
    this.code = code
    this.details = details
  }

  toResponseBody(): AcpErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    }
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/**
 * Map a wrkq/wrkf `WorkRpcError.domainCode` onto the ACP HTTP error boundary.
 * Not-found → 404; CAS / idempotency conflicts → 409; every other domain error
 * (validation, guard/blocker, forbidden, schema-behind) → 422. This replaces the
 * deleted wrkq-lib error hierarchy (we do NOT recreate those lookalike classes).
 */
function httpStatusForWorkRpcDomainCode(domainCode: string): number {
  if (domainCode.endsWith('_NOT_FOUND')) {
    return 404
  }
  if (
    domainCode.endsWith('_CONFLICT') ||
    domainCode.includes('STALE') ||
    domainCode.includes('IDEMPOTENCY')
  ) {
    return 409
  }
  return 422
}

export function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new AcpHttpError(400, 'malformed_request', message, details)
}

export function notFound(message: string, details?: Record<string, unknown>): never {
  throw new AcpHttpError(404, 'not_found', message, details)
}

export function conflict(message: string, details?: Record<string, unknown>): never {
  throw new AcpHttpError(409, 'idempotency_conflict', message, details)
}

export function unprocessable(
  code: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new AcpHttpError(422, code, message, details)
}

export function forbidden(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AcpHttpError(403, code, message, details)
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AcpHttpError) {
    return json(error.toResponseBody(), error.status)
  }

  if (error instanceof HrcDomainError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.detail,
        },
      } satisfies AcpErrorBody,
      error.status
    )
  }

  if (error instanceof ActorValidationError) {
    const validationError = error
    return json(
      {
        error: {
          code: 'malformed_request',
          message: validationError.message,
          details: { field: validationError.field },
        },
      } satisfies AcpErrorBody,
      400
    )
  }

  // wrkq/wrkf domain errors arrive as a single typed WorkRpcError carrying a
  // stable `domainCode` (WRKQ_/WRKF_*). Map it onto existing HTTP boundaries.
  // Protocol errors (domainCode undefined) fall through to the generic handler.
  if (error instanceof WorkRpcError && error.domainCode !== undefined) {
    const domainCode = error.domainCode
    const status = httpStatusForWorkRpcDomainCode(domainCode)
    return json(
      {
        error: {
          code: domainCode,
          message: error.message,
          ...(error.data !== undefined ? { details: { ...error.data } } : {}),
        },
      } satisfies AcpErrorBody,
      status
    )
  }

  if (error instanceof InputAttemptConflictError) {
    return json(
      {
        error: {
          code: 'idempotency_conflict',
          message: error.message,
          details: { idempotencyKey: error.idempotencyKey },
        },
      } satisfies AcpErrorBody,
      409
    )
  }

  if (error instanceof Error && error.message.includes('canonical SessionRef')) {
    return json(
      {
        error: {
          code: 'invalid_wake_session_ref',
          message: error.message,
        },
      } satisfies AcpErrorBody,
      422
    )
  }

  if (error instanceof Error && error.message.startsWith('Unknown ACP preset:')) {
    return json(
      {
        error: {
          code: 'preset_not_found',
          message: error.message,
        },
      } satisfies AcpErrorBody,
      404
    )
  }

  if (
    error instanceof Error &&
    (error.message.startsWith('Invalid ScopeRef') || error.message.startsWith('Invalid LaneRef'))
  ) {
    return json(
      {
        error: {
          code: 'malformed_request',
          message: error.message,
        },
      } satisfies AcpErrorBody,
      400
    )
  }

  return json(
    {
      error: {
        code: 'internal_error',
        message: 'internal server error',
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    } satisfies AcpErrorBody,
    500
  )
}
