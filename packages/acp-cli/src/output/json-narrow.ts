export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function parseDeliveryRef(
  ref: string | undefined
): { scopeRef?: string | undefined; laneRef?: string | undefined } | undefined {
  if (ref === undefined || ref.length === 0) return undefined
  try {
    const parsed = JSON.parse(ref) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['scopeRef'] === 'string' ? { scopeRef: record['scopeRef'] } : {}),
      ...(typeof record['laneRef'] === 'string' ? { laneRef: record['laneRef'] } : {}),
    }
  } catch {
    return undefined
  }
}
