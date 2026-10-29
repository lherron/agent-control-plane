import { type JobTrigger, isValidTimeZone, validateJobTrigger } from 'acp-core'
import { isValidCron, isWithinTickInterval, nextFireAfter } from './cron.js'
import type { JobRunTrigger, JobSchedule, ScheduleJobSkipReason } from './store-contracts.js'

function normalizeIsoSecondsCooldownForCore(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['kind'] === 'event'
  ) {
    const record = value as Record<string, unknown>
    const cooldown = record['cooldown']
    const match = typeof cooldown === 'string' ? /^PT([1-9][0-9]*)S$/.exec(cooldown) : null
    if (match !== null) {
      return { ...record, cooldown: `${match[1]}s` }
    }
  }
  return value
}

function validateStoreJobTrigger(
  value: unknown
): { valid: true; trigger: JobTrigger } | { valid: false; errors: string[] } {
  const validation = validateJobTrigger(value)
  if (validation.valid) {
    return validation
  }

  const normalized = normalizeIsoSecondsCooldownForCore(value)
  if (normalized === value) {
    return validation
  }

  const normalizedValidation = validateJobTrigger(normalized)
  if (!normalizedValidation.valid) {
    return validation
  }

  return {
    valid: true,
    trigger: normalizedValidation.trigger as JobTrigger,
  }
}

export function parseTriggerJson(value: string): JobTrigger {
  const validation = validateStoreJobTrigger(JSON.parse(value) as unknown)
  if (!validation.valid) {
    throw new Error(`stored trigger is invalid: ${validation.errors.join('; ')}`)
  }
  return validation.trigger
}

function getScheduleWindowValue(
  schedule: JobSchedule,
  field: 'windowStart' | 'windowEnd'
): string | null {
  const value = schedule[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function requireSchedule(schedule: JobSchedule): JobSchedule {
  if (!isValidCron(schedule.cron)) {
    throw new Error(`invalid cron schedule: ${schedule.cron}`)
  }
  if (
    schedule.timezone !== undefined &&
    (typeof schedule.timezone !== 'string' || !isValidTimeZone(schedule.timezone))
  ) {
    throw new Error(
      `invalid trigger: trigger.timezone must be an IANA time zone, got ${JSON.stringify(schedule.timezone)}`
    )
  }

  return schedule
}

function parseUtcTimeOfDay(value: string | undefined): number | null {
  if (value === undefined) {
    return null
  }

  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value)
  if (match === null) {
    return null
  }

  return Number.parseInt(match[1] ?? '0', 10) * 60 + Number.parseInt(match[2] ?? '0', 10)
}

function utcMinuteOfDay(iso: string): number | null {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) {
    return null
  }
  return value.getUTCHours() * 60 + value.getUTCMinutes()
}

function isInsideScheduleWindow(schedule: JobSchedule | undefined, now: string): boolean {
  const start = parseUtcTimeOfDay(schedule?.windowStart)
  const end = parseUtcTimeOfDay(schedule?.windowEnd)
  if (start === null || end === null) {
    return true
  }

  const current = utcMinuteOfDay(now)
  if (current === null) {
    return true
  }

  if (start <= end) {
    return current >= start && current <= end
  }

  return current >= start || current <= end
}

function isPastCatchUpBound(input: {
  schedule: JobSchedule | undefined
  dueAt: string
  now: string
}): boolean {
  const windowMinutes = input.schedule?.windowMinutes
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes < 0) {
    return false
  }

  const dueAt = new Date(input.dueAt).getTime()
  const now = new Date(input.now).getTime()
  if (Number.isNaN(dueAt) || Number.isNaN(now)) {
    return false
  }

  return now - dueAt > windowMinutes * 60_000
}

export function resolveScheduleClaimPolicy(input: {
  schedule: JobSchedule | undefined
  dueAt: string
  now: string
}): {
  triggeredBy: JobRunTrigger
  skipReason?: ScheduleJobSkipReason | undefined
} {
  const triggeredBy: JobRunTrigger = isWithinTickInterval({
    dueAt: input.dueAt,
    now: input.now,
  })
    ? 'schedule'
    : 'catch-up'

  if (!isInsideScheduleWindow(input.schedule, input.now)) {
    return { triggeredBy, skipReason: 'schedule_window' }
  }

  if (
    triggeredBy === 'catch-up' &&
    (input.schedule?.catchUp === 'none' || isPastCatchUpBound(input))
  ) {
    return { triggeredBy, skipReason: 'stale_catch_up_suppressed' }
  }

  return { triggeredBy }
}

function scheduleFromTrigger(trigger: Extract<JobTrigger, { kind: 'schedule' }>): JobSchedule {
  return {
    cron: trigger.cron,
    ...(trigger.windowStart !== undefined ? { windowStart: trigger.windowStart } : {}),
    ...(trigger.windowEnd !== undefined ? { windowEnd: trigger.windowEnd } : {}),
    ...(trigger.windowMinutes !== undefined ? { windowMinutes: trigger.windowMinutes } : {}),
    ...(trigger.catchUp !== undefined ? { catchUp: trigger.catchUp } : {}),
    ...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
  }
}

/** Resolve the canonical trigger for a job, promoting a legacy `schedule` input. */
export function resolveTrigger(input: {
  trigger?: JobTrigger | undefined
  schedule?: JobSchedule | undefined
}): JobTrigger {
  if (input.trigger !== undefined) {
    const validation = validateStoreJobTrigger(input.trigger)
    if (!validation.valid) {
      throw new Error(`invalid trigger: ${validation.errors.join('; ')}`)
    }
    return validation.trigger
  }
  if (input.schedule !== undefined) {
    return {
      kind: 'schedule',
      cron: input.schedule.cron,
      ...(typeof input.schedule.windowStart === 'string'
        ? { windowStart: input.schedule.windowStart }
        : {}),
      ...(typeof input.schedule.windowEnd === 'string'
        ? { windowEnd: input.schedule.windowEnd }
        : {}),
      ...(typeof input.schedule.windowMinutes === 'number'
        ? { windowMinutes: input.schedule.windowMinutes }
        : {}),
      ...(input.schedule.catchUp === 'none' || input.schedule.catchUp === 'one'
        ? { catchUp: input.schedule.catchUp }
        : {}),
      ...(input.schedule.timezone !== undefined ? { timezone: input.schedule.timezone } : {}),
    }
  }
  throw new Error('job requires a trigger or schedule')
}

type JobScheduleColumns = {
  scheduleCron: string | null
  windowStart: string | null
  windowEnd: string | null
  scheduleJson: string | null
  nextFireAt: string | null
}

/**
 * Derive the schedule-only denormalized columns + next_fire_at from a trigger.
 * Event triggers leave every schedule column null (next_fire_at is a
 * schedule-only readiness index, NOT generic trigger readiness).
 */
export function scheduleColumnsForTrigger(input: {
  trigger: JobTrigger
  schedule?: JobSchedule | undefined
  disabled: boolean
  anchor: string
}): JobScheduleColumns {
  if (input.trigger.kind !== 'schedule') {
    return {
      scheduleCron: null,
      windowStart: null,
      windowEnd: null,
      scheduleJson: null,
      nextFireAt: null,
    }
  }
  const schedule = requireSchedule(input.schedule ?? scheduleFromTrigger(input.trigger))
  return {
    scheduleCron: schedule.cron,
    windowStart: getScheduleWindowValue(schedule, 'windowStart'),
    windowEnd: getScheduleWindowValue(schedule, 'windowEnd'),
    scheduleJson: JSON.stringify(schedule),
    nextFireAt: input.disabled
      ? null
      : nextFireAfter(schedule.cron, input.anchor, schedule.timezone),
  }
}
