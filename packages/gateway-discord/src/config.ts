export const DEFAULT_MAX_CHARS = 2000
export const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024
export const DEFAULT_BINDINGS_REFRESH_MS = 30_000
export const DEFAULT_DELIVERY_POLL_MS = 1_000
export const DEFAULT_DELIVERY_IDLE_MS = 2_500

export const MEDIA_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
}

export function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.length > 0) {
      return value
    }
  }

  throw new Error(`Missing required env var: ${names.join(' or ')}`)
}

export function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.length > 0) {
      return value
    }
  }

  return undefined
}

export function envNumber(names: string[], fallback: number): number {
  const rawValue = optionalEnv(...names)
  if (rawValue === undefined) {
    return fallback
  }

  const parsed = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}
