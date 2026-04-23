import { ActorValidationError } from 'acp-core'
import { InputAttemptConflictError } from 'acp-state-store'
import {
  VersionConflictError,
  WrkqProjectNotFoundError,
  WrkqSchemaMissingError,
  WrkqTaskNotFoundError,
} from 'wrkq-lib'

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

  if (error instanceof WrkqTaskNotFoundError || error instanceof WrkqProjectNotFoundError) {
    return json(
      {
        error: {
          code: 'not_found',
          message: error.message,
        },
      } satisfies AcpErrorBody,
      404
    )
  }

  if (error instanceof VersionConflictError) {
    return json(
      {
        error: {
          code: 'version_conflict',
          message: error.message,
        },
      } satisfies AcpErrorBody,
      422
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

  if (error instanceof WrkqSchemaMissingError) {
    return json(
      {
        error: {
          code: 'wrkq_schema_missing',
          message: error.message,
          details: { missing: [...error.missing] },
        },
      } satisfies AcpErrorBody,
      500
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
