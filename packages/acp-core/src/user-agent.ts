/**
 * First-party HTTP clients of acp-server identify themselves with a
 * `<name>/<version>` User-Agent built from their own package.json, so the
 * request log's `client` field names who still calls a route (logging.md L3).
 */
import { readFileSync } from 'node:fs'

type FetchFunction = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

/**
 * `packageJsonUrl` is the caller's package.json, e.g.
 * `new URL('../package.json', import.meta.url)` from a top-level `src/` file
 * (the same relative path holds from `dist/`).
 */
export function firstPartyUserAgent(packageJsonUrl: URL): string {
  const manifest = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`package.json at ${packageJsonUrl.href} lacks a name or version`)
  }
  return `${manifest.name}/${manifest.version}`
}

/** Wraps `fetchImpl` so every request carries `userAgent` unless it set its own. */
export function withUserAgent<F extends FetchFunction>(fetchImpl: F, userAgent: string): F {
  const wrapped = (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent)
    return fetchImpl(input, { ...init, headers })
  }
  return wrapped as F
}

/**
 * The global fetch with `userAgent` added. The global is looked up per call, so
 * a fetch swapped in after import (tests) is the one used.
 */
export function firstPartyFetch(userAgent: string): typeof fetch {
  const globalFetch: FetchFunction = (input, init) => fetch(input, init)
  return withUserAgent(globalFetch, userAgent) as typeof fetch
}

const CLIENT_TOKEN = /^([A-Za-z0-9._~+-]{1,64})\/([A-Za-z0-9._~+-]{1,64})/

/** The leading `<name>/<version>` product token of a User-Agent, else `unknown`. */
export function clientFromUserAgent(userAgent: string | null | undefined): string {
  const match = CLIENT_TOKEN.exec(userAgent?.trim() ?? '')
  return match === null ? 'unknown' : `${match[1]}/${match[2]}`
}
