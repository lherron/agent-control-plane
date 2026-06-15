export function readObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function readPlainRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {}
}

export function readOptionalPlainRecord(
  input: Record<string, unknown> | undefined,
  field: string
): Record<string, unknown> | undefined {
  const value = input?.[field]
  return isPlainRecord(value) ? value : undefined
}

export function readOptionalNonEmptyString(
  input: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  const value = input?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readOptionalFiniteNumber(
  input: Record<string, unknown> | undefined,
  field: string
): number | undefined {
  const value = input?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readOptionalTrimmedRawString(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }
  return value
}

export function readOptionalTrimmedRawStringOrThrow(
  input: Record<string, unknown>,
  field: string,
  createError: (field: string) => Error
): string | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createError(field)
  }

  return value
}

export function readOptionalTrimmedStringOrThrow(
  input: Record<string, unknown>,
  field: string,
  createError: (field: string) => Error
): string | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createError(field)
  }

  return value.trim()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
