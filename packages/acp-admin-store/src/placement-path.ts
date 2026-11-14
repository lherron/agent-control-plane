export function validateOptionalPath(
  value: string | null | undefined,
  fieldName: string
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty when provided`)
  }
  return value
}
