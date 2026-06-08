export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readOptionalString(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  const value = input[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readOptionalNumber(
  input: Record<string, unknown>,
  field: string
): number | undefined {
  const value = input[field]
  return typeof value === 'number' ? value : undefined
}

export function readOptionalBoolean(
  input: Record<string, unknown>,
  field: string
): boolean | undefined {
  const value = input[field]
  return typeof value === 'boolean' ? value : undefined
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

export function requireString(
  input: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = readOptionalString(input, field)
  if (value === undefined) {
    throw new Error(`${label}.${field} must be a non-empty string`)
  }
  return value
}

export function requireNumber(
  input: Record<string, unknown>,
  field: string,
  label: string
): number {
  const value = input[field]
  if (typeof value !== 'number') {
    throw new Error(`${label}.${field} must be a number`)
  }
  return value
}

export function readOptionalStringArray(
  input: Record<string, unknown>,
  field: string,
  label: string
): string[] | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label}.${field} must be an array of strings`)
  }
  return [...value]
}

export function readOptionalRecordField(
  input: Record<string, unknown>,
  field: string,
  label: string
): Record<string, unknown> | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  return requireRecord(value, `${label}.${field}`)
}
