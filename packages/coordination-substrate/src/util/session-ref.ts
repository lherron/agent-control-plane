import { type SessionRef, normalizeSessionRef } from 'agent-scope'

const SESSION_REF_DELIMITER = '~'

function invalidSessionRefError(): Error {
  return new Error('Wake requests require a canonical SessionRef with an explicit laneRef')
}

/**
 * Validates that the given (scopeRef, laneRef) pair is already in canonical
 * form (normalization is a no-op) and returns the normalized ref. Throws the
 * shared invalid-session-ref error otherwise. Single enforcer of the
 * canonical-encoding invariant for both the object and string parse paths.
 */
function assertCanonical(scopeRef: string, laneRef: string): SessionRef {
  const normalized = normalizeSessionRef({ scopeRef, laneRef })
  if (normalized.scopeRef !== scopeRef || normalized.laneRef !== laneRef) {
    throw invalidSessionRefError()
  }

  return normalized
}

export function canonicalizeSessionRef(value: unknown): SessionRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSessionRefError()
  }

  const scopeRef = Reflect.get(value, 'scopeRef')
  const laneRef = Reflect.get(value, 'laneRef')

  if (typeof scopeRef !== 'string' || typeof laneRef !== 'string') {
    throw invalidSessionRefError()
  }

  return assertCanonical(scopeRef, laneRef)
}

export function formatCanonicalSessionRef(value: SessionRef): string {
  const normalized = canonicalizeSessionRef(value)
  return `${normalized.scopeRef}${SESSION_REF_DELIMITER}${normalized.laneRef}`
}

export function parseCanonicalSessionRef(value: string): SessionRef {
  const delimiterIndex = value.indexOf(SESSION_REF_DELIMITER)
  if (delimiterIndex <= 0 || delimiterIndex === value.length - 1) {
    throw invalidSessionRefError()
  }

  const scopeRef = value.slice(0, delimiterIndex)
  const laneRef = value.slice(delimiterIndex + 1)

  return assertCanonical(scopeRef, laneRef)
}

export function isCanonicalSessionRef(value: unknown): value is SessionRef {
  try {
    canonicalizeSessionRef(value)
    return true
  } catch {
    return false
  }
}
