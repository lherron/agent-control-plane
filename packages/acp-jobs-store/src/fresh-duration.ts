const FRESH_DURATION_PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

const MS_PER_SECOND = 1_000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

export function parseFreshDurationMs(value: string): number | undefined {
  const match = FRESH_DURATION_PATTERN.exec(value)
  if (match === null) {
    return undefined
  }

  const [, daysText, hoursText, minutesText, secondsText] = match
  if (
    daysText === undefined &&
    hoursText === undefined &&
    minutesText === undefined &&
    secondsText === undefined
  ) {
    return undefined
  }

  const days = parseComponent(daysText)
  const hours = parseComponent(hoursText)
  const minutes = parseComponent(minutesText)
  const seconds = parseComponent(secondsText)
  const total =
    days * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND

  return total > 0 && Number.isSafeInteger(total) ? total : undefined
}

export function isValidFreshDuration(value: unknown): value is string {
  return typeof value === 'string' && parseFreshDurationMs(value) !== undefined
}

function parseComponent(value: string | undefined): number {
  return value === undefined ? 0 : Number.parseInt(value, 10)
}
