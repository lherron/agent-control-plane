/**
 * Transport peer identity for a single HTTP request.
 *
 * Bun hands the socket peer to the `fetch` callback via `server.requestIP(request)`
 * only — it is not reachable from a `Request` object. Routes that must reason about
 * WHERE a request physically came from (rather than what it claims in headers) need
 * it threaded explicitly, so `createAcpServer().handler()` takes it as an option and
 * publishes it on `RouteContext.peer`.
 *
 * Deliberately NOT derived from `X-Forwarded-For`/`Forwarded`: those are client-
 * controlled and would make a loopback gate spoofable by any remote caller.
 */
export type RequestPeer = {
  address: string
  family?: string | undefined
  port?: number | undefined
}

const IPV4_MAPPED_PREFIXES = ['::ffff:', '::FFFF:']
const IPV4_DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function normalizeAddress(address: string): string {
  const trimmed = address.trim()
  // Bun may report a zone-scoped v6 address (`fe80::1%en0`); the zone is not
  // part of the identity we gate on.
  const withoutZone = trimmed.split('%')[0] ?? trimmed
  const unbracketed =
    withoutZone.startsWith('[') && withoutZone.endsWith(']')
      ? withoutZone.slice(1, -1)
      : withoutZone
  for (const prefix of IPV4_MAPPED_PREFIXES) {
    if (unbracketed.startsWith(prefix)) {
      return unbracketed.slice(prefix.length)
    }
  }
  return unbracketed
}

// The whole 127.0.0.0/8 block is loopback, but only as a well-formed dotted quad:
// a prefix test alone would accept a hostname like `127.0.0.1.evil.test`.
function isIpv4LoopbackAddress(address: string): boolean {
  const match = IPV4_DOTTED_QUAD.exec(address)
  if (match === null) {
    return false
  }
  const octets = match.slice(1).map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  return octets[0] === 127
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeAddress(address)
  if (normalized.length === 0) {
    return false
  }
  if (isIpv4LoopbackAddress(normalized)) {
    return true
  }
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

/**
 * Fail-closed loopback test. An absent peer (a caller that did not thread the
 * socket address through) is NOT loopback: a gate that cannot observe the peer
 * must deny, never assume local.
 */
export function isLoopbackPeer(peer: RequestPeer | undefined): boolean {
  if (peer === undefined) {
    return false
  }
  return isLoopbackAddress(peer.address)
}
