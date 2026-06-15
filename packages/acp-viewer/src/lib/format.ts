// Shared formatters for actor refs and long-form date/time presentation.
// The compact jobs date format (month/day/hour/minute, '—' fallback) is
// deliberately different and lives with its call sites.

export function formatActor(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    const actor = value as { kind?: unknown; id?: unknown }
    const kind = typeof actor.kind === 'string' ? actor.kind : 'actor'
    const id = typeof actor.id === 'string' ? actor.id : undefined
    return id === undefined ? kind : `${kind}:${id}`
  }

  return 'Unknown'
}

export function formatDateTime(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0) {
    return 'None'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
