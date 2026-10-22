// CORS for Loggia plugin islands (T-11492). Loggia's plugin.json `connect`
// admits a loopback origin to an island's CSP; the browser still needs the
// server's CORS consent. Only island origins (`loggia-plugin://<id>`) from a
// loopback peer get it, so no web page gains access to ACP.

const ISLAND_SCHEME = 'loggia-plugin://'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function islandCorsOrigin(
  request: Request,
  peer: { address: string } | undefined
): string | undefined {
  const origin = request.headers.get('origin')
  if (origin === null || !origin.startsWith(ISLAND_SCHEME)) return undefined
  if (peer === undefined || !LOOPBACK.has(peer.address)) return undefined
  return origin
}

export function islandPreflight(origin: string, request: Request): Response {
  const headers = new Headers({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  })
  const requested = request.headers.get('access-control-request-headers')
  if (requested !== null) headers.set('access-control-allow-headers', requested)
  return new Response(null, { status: 204, headers })
}

export function withIslandCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.append('vary', 'Origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
