import type { JobOutputConfig, JobOutputSink } from 'acp-jobs-store'

import { isRecord } from '../parsers/body.js'

export type JobOutputValidationResult =
  | { valid: true; output: JobOutputConfig }
  | { valid: false; errors: string[] }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const OUTPUT_KEYS = new Set(['sinks', 'delivery'])

/** Bounded sink-delivery policy (T-10005). Absent fields use the reconciler's
 * global defaults. */
export type JobOutputDeliveryPolicy = {
  maxAttempts: number
  maxAgeSeconds: number
}

const DELIVERY_BOUNDS: Record<keyof JobOutputDeliveryPolicy, readonly [number, number]> = {
  maxAttempts: [1, 1000],
  maxAgeSeconds: [60, 604_800],
}

export function validateJobOutputConfig(value: unknown): JobOutputValidationResult {
  if (!isRecord(value)) {
    return { valid: false, errors: ['output must be an object'] }
  }
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!OUTPUT_KEYS.has(key)) {
      errors.push(`output.${key} is not supported`)
    }
  }
  const sinks = value['sinks']
  if (!Array.isArray(sinks)) {
    return { valid: false, errors: [...errors, 'output.sinks must be an array'] }
  }
  if (sinks.length === 0) {
    return { valid: false, errors: [...errors, 'output.sinks must not be empty'] }
  }

  const delivery = validateDeliveryPolicy(value['delivery'], errors)
  const normalized: JobOutputSink[] = []
  sinks.forEach((sink, index) => {
    const prefix = `output.sinks[${index}]`
    if (!isRecord(sink)) {
      errors.push(`${prefix} must be an object`)
      return
    }

    const allowed = new Set(['kind', 'url', 'format', 'include'])
    for (const key of Object.keys(sink)) {
      if (!allowed.has(key)) {
        errors.push(`${prefix}.${key} is not supported in v1`)
      }
    }

    if (sink['kind'] !== 'webhook') {
      errors.push(`${prefix}.kind must be webhook`)
      return
    }

    const url = sink['url']
    if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push(`${prefix}.url must be a non-empty string`)
      return
    }
    if (!isLoopbackWebhookUrl(url)) {
      errors.push(`${prefix}.url must be loopback http(s)`)
      return
    }

    const format = sink['format']
    if (format !== undefined && (typeof format !== 'string' || format.trim().length === 0)) {
      errors.push(`${prefix}.format must be a non-empty string when present`)
      return
    }

    const include = sink['include']
    if (
      include !== undefined &&
      (!Array.isArray(include) || include.some((entry) => typeof entry !== 'string'))
    ) {
      errors.push(`${prefix}.include must be an array of strings when present`)
      return
    }

    normalized.push({
      kind: 'webhook',
      url: url.trim(),
      ...(typeof format === 'string' ? { format: format.trim() } : {}),
      ...(Array.isArray(include) ? { include: [...include] } : {}),
    })
  })

  return errors.length === 0
    ? {
        valid: true,
        output: { sinks: normalized, ...(delivery !== undefined ? { delivery } : {}) },
      }
    : { valid: false, errors }
}

function validateDeliveryPolicy(
  value: unknown,
  errors: string[]
): Partial<JobOutputDeliveryPolicy> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    errors.push('output.delivery must be an object')
    return undefined
  }
  const policy: Partial<JobOutputDeliveryPolicy> = {}
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(DELIVERY_BOUNDS, key)) {
      errors.push(`output.delivery.${key} is not supported`)
      continue
    }
    const name = key as keyof JobOutputDeliveryPolicy
    const [min, max] = DELIVERY_BOUNDS[name]
    if (typeof field !== 'number' || !Number.isInteger(field) || field < min || field > max) {
      errors.push(`output.delivery.${name} must be an integer from ${min} to ${max}`)
      continue
    }
    policy[name] = field
  }
  return policy
}

/** Read a run's (already validated) output.delivery snapshot; malformed or
 * absent fields fall back to the defaults. */
export function resolveJobOutputDeliveryPolicy(
  output: Readonly<Record<string, unknown>> | undefined,
  defaults: JobOutputDeliveryPolicy
): JobOutputDeliveryPolicy {
  const delivery = output?.['delivery']
  if (!isRecord(delivery)) {
    return defaults
  }
  const pick = (name: keyof JobOutputDeliveryPolicy): number => {
    const field = delivery[name]
    const [min, max] = DELIVERY_BOUNDS[name]
    return typeof field === 'number' && Number.isInteger(field) && field >= min && field <= max
      ? field
      : defaults[name]
  }
  return { maxAttempts: pick('maxAttempts'), maxAgeSeconds: pick('maxAgeSeconds') }
}

export function isLoopbackWebhookUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  return LOOPBACK_HOSTS.has(url.hostname)
}
