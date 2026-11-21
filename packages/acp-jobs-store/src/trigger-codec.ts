import { type JobTrigger, validateJobTrigger } from 'acp-core'

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

export function requireEventTrigger(value: unknown): Extract<JobTrigger, { kind: 'event' }> {
  const validation = validateStoreJobTrigger(value)
  if (!validation.valid) {
    throw new Error(`invalid trigger: ${validation.errors.join('; ')}`)
  }
  if (validation.trigger.kind !== 'event') {
    throw new Error('ACP jobs require an event trigger')
  }
  return validation.trigger
}
