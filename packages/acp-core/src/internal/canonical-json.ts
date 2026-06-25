import { createHash } from 'node:crypto'

export function stripUndefinedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedKeys(item)) as T
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const stripped: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      stripped[key] = stripUndefinedKeys(source[key])
    }
  }
  return stripped as T
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      sorted[key] = sortJson(source[key])
    }
  }
  return sorted
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}
