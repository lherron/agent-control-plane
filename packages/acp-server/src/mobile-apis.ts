import { loopbackUpstreamRefusal } from './loopback-upstream.js'

export const MOBILE_API_ROOT = '/v1/mobile/apis/'

const mobileApis = new Map([
  ['signal-dial', { origin: new URL('http://127.0.0.1:18551'), prefix: '/api/dial/' }],
])

for (const [id, { origin }] of mobileApis) {
  const refusal = loopbackUpstreamRefusal(origin)
  if (refusal !== undefined) throw new Error(`Invalid mobile API ${id}: ${refusal}`)
}

export function getMobileApi(id: string): { origin: URL; prefix: string } | undefined {
  return mobileApis.get(id)
}

export function mobileApiIdForScope(scope: string): string | undefined {
  if (!scope.startsWith('api:')) return undefined
  const id = scope.slice('api:'.length)
  return mobileApis.has(id) ? id : undefined
}

export function matchesMobileApiScope(pathname: string, scope: string): boolean {
  const apiId = mobileApiIdForScope(scope)
  if (apiId === undefined || !pathname.startsWith(MOBILE_API_ROOT)) return false
  const path = pathname.slice(MOBILE_API_ROOT.length)
  const separator = path.indexOf('/')
  if (separator < 0 || separator === path.length - 1) return false
  try {
    return decodeURIComponent(path.slice(0, separator)) === apiId
  } catch {
    return false
  }
}

/**
 * Bun can leave a connection open after an early response, even with
 * Connection: close. Read through the request boundary before replying.
 * The listener bounds upload bytes and shortens the idle timeout on discard.
 */
export async function discardRequestBody(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>,
  onDiscard?: () => void
): Promise<void> {
  onDiscard?.()
  try {
    while (!(await reader.read()).done) {
      // Discard each chunk as it comes in.
    }
  } catch {
    // The transport aborted the upload or closed the connection.
  }
}

export async function discardUnreadRequestBody(
  request: Request,
  onDiscard?: () => void
): Promise<void> {
  if (request.bodyUsed || request.body === null) return
  const reader = request.body.getReader()
  try {
    await discardRequestBody(reader, onDiscard)
  } finally {
    reader.releaseLock()
  }
}
