const MAX_INGRESS_FAILURE_REASON_CHARS = 400

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function pickNonEmptyString(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = obj?.[key]
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  return undefined
}

export function extractIngressFailureReason(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return truncateReason(trimmed)
  }

  const err = asRecord(asRecord(parsed)?.['error'])
  // Prefer `details.cause` (most specific), fall back to `error.message`.
  const cause = pickNonEmptyString(asRecord(err?.['details']), 'cause')
  if (cause) return truncateReason(cause)
  const message = pickNonEmptyString(err, 'message')
  if (message) return truncateReason(message)

  return truncateReason(trimmed)
}

export function truncateReason(reason: string): string {
  if (reason.length <= MAX_INGRESS_FAILURE_REASON_CHARS) return reason
  return `${reason.slice(0, MAX_INGRESS_FAILURE_REASON_CHARS - 1)}…`
}
