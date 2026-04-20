import { badRequest } from '../http.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    badRequest('request body must be valid JSON')
  }
}

export function requireRecord(value: unknown, field = 'body'): Record<string, unknown> {
  if (!isRecord(value)) {
    badRequest(`${field} must be an object`, { field })
  }

  return value
}

export function requireTrimmedStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} must be a non-empty string`, { field })
  }

  return value.trim()
}

export function readOptionalTrimmedStringField(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} must be a non-empty string`, { field })
  }

  return value.trim()
}

export function requireNumberField(input: Record<string, unknown>, field: string): number {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    badRequest(`${field} must be a finite number`, { field })
  }

  return value
}

export function readOptionalBooleanField(
  input: Record<string, unknown>,
  field: string
): boolean | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    badRequest(`${field} must be a boolean`, { field })
  }

  return value
}

export function readOptionalRecordField(
  input: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  return requireRecord(value, field)
}

export function readOptionalArrayField(
  input: Record<string, unknown>,
  field: string
): unknown[] | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    badRequest(`${field} must be an array`, { field })
  }

  return value
}
