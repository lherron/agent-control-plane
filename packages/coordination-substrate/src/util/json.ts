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

export function parseJson<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as T
}
