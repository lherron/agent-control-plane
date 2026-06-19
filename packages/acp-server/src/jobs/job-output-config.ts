import type { JobOutputConfig, JobOutputSink } from 'acp-jobs-store'

import { isRecord } from '../parsers/body.js'

export type JobOutputValidationResult =
  | { valid: true; output: JobOutputConfig }
  | { valid: false; errors: string[] }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function validateJobOutputConfig(value: unknown): JobOutputValidationResult {
  if (!isRecord(value)) {
    return { valid: false, errors: ['output must be an object'] }
  }
  const sinks = value['sinks']
  if (!Array.isArray(sinks)) {
    return { valid: false, errors: ['output.sinks must be an array'] }
  }
  if (sinks.length === 0) {
    return { valid: false, errors: ['output.sinks must not be empty'] }
  }

  const errors: string[] = []
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
    ? { valid: true, output: { sinks: normalized } }
    : { valid: false, errors }
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
