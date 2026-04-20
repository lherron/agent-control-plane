import { type SessionRef, normalizeSessionRef } from 'agent-scope'

function invalidSessionRefError(): Error {
  return new Error('Wake requests require a canonical SessionRef with an explicit laneRef')
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

  const normalized = normalizeSessionRef({ scopeRef, laneRef })
  if (normalized.scopeRef !== scopeRef || normalized.laneRef !== laneRef) {
    throw invalidSessionRefError()
  }

  return normalized
}

export function formatCanonicalSessionRef(value: SessionRef): string {
  const normalized = canonicalizeSessionRef(value)
  return `${normalized.scopeRef}~${normalized.laneRef}`
}

export function parseCanonicalSessionRef(value: string): SessionRef {
  const delimiterIndex = value.indexOf('~')
  if (delimiterIndex <= 0 || delimiterIndex === value.length - 1) {
    throw invalidSessionRefError()
  }

  const scopeRef = value.slice(0, delimiterIndex)
  const laneRef = value.slice(delimiterIndex + 1)
  const normalized = normalizeSessionRef({ scopeRef, laneRef })

  if (`${normalized.scopeRef}~${normalized.laneRef}` !== value) {
    throw invalidSessionRefError()
  }

  return normalized
}

export function isCanonicalSessionRef(value: unknown): value is SessionRef {
  try {
    canonicalizeSessionRef(value)
    return true
  } catch {
    return false
  }
}
