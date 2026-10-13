// Upper bound on the minute-by-minute scan in `nextFireAfter`: 5 years of
// minutes (60 min * 24 h * 366 days * 5 years). Guards against a cron that
// can never fire walking forever.
const MAX_FIRE_SCAN_MINUTES = 60 * 24 * 366 * 5

type CronField = {
  matches(value: number): boolean
}

type ParsedCron = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  /**
   * Cronie's "fixed-time" entry: neither the minute nor the hour field starts
   * with `*`. Only these get DST gap catch-up and overlap de-duplication.
   */
  fixedTime: boolean
}

type FieldBounds = {
  min: number
  max: number
}

function parseNumber(token: string, bounds: FieldBounds): number | null {
  if (!/^\d+$/.test(token)) {
    return null
  }

  const value = Number.parseInt(token, 10)
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return null
  }

  return value
}

function parseFieldPart(source: string, bounds: FieldBounds): CronField | null {
  if (source === '*') {
    return { matches: () => true }
  }

  if (source.startsWith('*/')) {
    const every = parseNumber(source.slice(2), { min: 1, max: bounds.max })
    if (every === null || every <= 0) {
      return null
    }

    return { matches: (value) => value % every === 0 }
  }

  if (source.includes('-')) {
    const [startToken, rest] = source.split('-', 2)
    if (startToken === undefined || rest === undefined) {
      return null
    }

    const [endToken, stepToken] = rest.split('/', 2)
    if (endToken === undefined) {
      return null
    }
    const start = parseNumber(startToken, bounds)
    const end = parseNumber(endToken, bounds)
    if (start === null || end === null || start > end) {
      return null
    }

    const step =
      stepToken === undefined
        ? 1
        : parseNumber(stepToken, { min: 1, max: bounds.max - bounds.min + 1 })
    if (step === null || step <= 0) {
      return null
    }

    return {
      matches: (value) => value >= start && value <= end && (value - start) % step === 0,
    }
  }

  const exact = parseNumber(source, bounds)
  if (exact === null) {
    return null
  }

  return { matches: (value) => value === exact }
}

function parseField(source: string, bounds: FieldBounds): CronField | null {
  const parts = source.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return null
  }

  const parsed = parts.map((part) => parseFieldPart(part, bounds))
  if (parsed.some((part) => part === null)) {
    return null
  }

  return {
    matches(value: number): boolean {
      return parsed.some((part) => part?.matches(value) === true)
    },
  }
}

function parseCron(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    return null
  }

  const minute = parseField(parts[0] ?? '', { min: 0, max: 59 })
  const hour = parseField(parts[1] ?? '', { min: 0, max: 23 })
  const dayOfMonth = parseField(parts[2] ?? '', { min: 1, max: 31 })
  const month = parseField(parts[3] ?? '', { min: 1, max: 12 })
  const dayOfWeek = parseField(parts[4] ?? '', { min: 0, max: 6 })

  if (
    minute === null ||
    hour === null ||
    dayOfMonth === null ||
    month === null ||
    dayOfWeek === null
  ) {
    return null
  }

  const fixedTime = !(parts[0] ?? '').startsWith('*') && !(parts[1] ?? '').startsWith('*')
  return { minute, hour, dayOfMonth, month, dayOfWeek, fixedTime }
}

function floorToUtcMinute(input: Date): Date {
  const next = new Date(input.getTime())
  next.setUTCSeconds(0, 0)
  return next
}

function matchesCron(parsed: ParsedCron, value: Date): boolean {
  return (
    parsed.minute.matches(value.getUTCMinutes()) &&
    parsed.hour.matches(value.getUTCHours()) &&
    parsed.dayOfMonth.matches(value.getUTCDate()) &&
    parsed.month.matches(value.getUTCMonth() + 1) &&
    parsed.dayOfWeek.matches(value.getUTCDay())
  )
}

export function isValidCron(cron: string): boolean {
  return parseCron(cron) !== null
}

/**
 * Next fire instant strictly after `afterIso`. Without `timezone` the cron
 * fields match UTC (the original behavior). With an IANA `timezone` they match
 * wall-clock time in that zone, with cronie's DST rules for fixed-time entries:
 * a time inside a spring-forward gap fires once at the first instant after the
 * gap, and a time inside a fall-back overlap fires only on its first
 * occurrence. Wildcard/step entries simply match real wall-clock minutes.
 */
export function nextFireAfter(
  cron: string,
  afterIso: string,
  timezone?: string | undefined
): string | null {
  const parsed = parseCron(cron)
  if (parsed === null) {
    return null
  }

  const after = new Date(afterIso)
  if (Number.isNaN(after.getTime())) {
    return null
  }

  let cursor = floorToUtcMinute(after)
  cursor = new Date(cursor.getTime() + 60_000)

  if (timezone !== undefined) {
    return nextZonedFire(parsed, cursor.getTime(), timezone)
  }

  for (let index = 0; index < MAX_FIRE_SCAN_MINUTES; index += 1) {
    if (matchesCron(parsed, cursor)) {
      return cursor.toISOString()
    }

    cursor = new Date(cursor.getTime() + 60_000)
  }

  return null
}

const MINUTE_MS = 60_000
// Real DST shifts are at most 2h and months apart, so an offset read 3h
// earlier is the pre-transition offset whenever `ms` sits in an overlap.
const OVERLAP_LOOKBACK_MS = 3 * 60 * MINUTE_MS

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    zoneFormatters.set(timezone, formatter)
  }
  return formatter
}

/** UTC offset (ms, local minus UTC) of `timezone` at the minute-aligned instant `ms`. */
function zoneOffsetMs(timezone: string, ms: number): number {
  const fields: Record<string, number> = {}
  for (const part of zoneFormatter(timezone).formatToParts(ms)) {
    if (part.type !== 'literal') fields[part.type] = Number.parseInt(part.value, 10)
  }
  const localAsUtc = Date.UTC(
    fields['year'] ?? 1970,
    (fields['month'] ?? 1) - 1,
    fields['day'] ?? 1,
    fields['hour'] ?? 0,
    fields['minute'] ?? 0
  )
  return localAsUtc - ms
}

/** True when the wall-clock time at `ms` already occurred earlier (fall-back overlap). */
function isRepeatedWallTime(timezone: string, ms: number, offset: number): boolean {
  const earlierOffset = zoneOffsetMs(timezone, ms - OVERLAP_LOOKBACK_MS)
  if (earlierOffset <= offset) return false
  return zoneOffsetMs(timezone, ms - (earlierOffset - offset)) === earlierOffset
}

// IANA transitions land on 15-minute UTC boundaries, so the walk reads the
// zone offset once per block instead of once per minute.
const OFFSET_BLOCK_MS = 15 * MINUTE_MS

function nextZonedFire(parsed: ParsedCron, startMs: number, timezone: string): string | null {
  let previousOffset = zoneOffsetMs(timezone, startMs - MINUTE_MS)
  let blockStartMs = Number.NaN
  let blockOffset = 0
  let cursorMs = startMs
  for (let index = 0; index < MAX_FIRE_SCAN_MINUTES; index += 1) {
    const cursorBlockMs = cursorMs - (cursorMs % OFFSET_BLOCK_MS)
    if (cursorBlockMs !== blockStartMs) {
      blockStartMs = cursorBlockMs
      blockOffset = zoneOffsetMs(timezone, cursorBlockMs)
    }
    const offset = blockOffset
    const localMs = cursorMs + offset
    if (parsed.fixedTime) {
      // Spring-forward: the wall-clock minutes [previous local + 1m, local) were
      // skipped. A fixed-time entry due in that gap fires now, once.
      for (let skipped = cursorMs + previousOffset; skipped < localMs; skipped += MINUTE_MS) {
        if (matchesCron(parsed, new Date(skipped))) return new Date(cursorMs).toISOString()
      }
      if (
        matchesCron(parsed, new Date(localMs)) &&
        !isRepeatedWallTime(timezone, cursorMs, offset)
      ) {
        return new Date(cursorMs).toISOString()
      }
    } else if (matchesCron(parsed, new Date(localMs))) {
      return new Date(cursorMs).toISOString()
    }
    previousOffset = offset
    cursorMs += MINUTE_MS
  }
  return null
}

export function isWithinTickInterval(input: {
  dueAt: string
  now: string
  tickMs?: number | undefined
}): boolean {
  const dueAt = new Date(input.dueAt).getTime()
  const now = new Date(input.now).getTime()
  if (Number.isNaN(dueAt) || Number.isNaN(now)) {
    return false
  }

  const elapsedMs = now - dueAt
  return elapsedMs >= 0 && elapsedMs < (input.tickMs ?? 60_000)
}
