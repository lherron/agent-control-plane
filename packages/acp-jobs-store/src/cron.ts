type CronField = {
  matches(value: number): boolean
}

type ParsedCron = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
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

  return { minute, hour, dayOfMonth, month, dayOfWeek }
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

export function nextFireAfter(cron: string, afterIso: string): string | null {
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

  const maxIterations = 60 * 24 * 366 * 5
  for (let index = 0; index < maxIterations; index += 1) {
    if (matchesCron(parsed, cursor)) {
      return cursor.toISOString()
    }

    cursor = new Date(cursor.getTime() + 60_000)
  }

  return null
}
