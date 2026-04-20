function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = normalizeJsonValue((value as Record<string, unknown>)[key])
        return accumulator
      }, {})
  }

  return value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseJsonValue(value: string | null): unknown {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as unknown
}

export function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(value)
  if (parsed === undefined) {
    return undefined
  }

  if (!isRecord(parsed)) {
    throw new Error('Expected JSON object payload')
  }

  return parsed
}
