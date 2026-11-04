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

/** Adds client and resolved caller attribution, preserving explicit headers. */
export function withUserAgent<F extends FetchFunction>(
  fetchImpl: F,
  userAgent: string,
  caller: string = resolveCaller()
): F {
  const wrapped = (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent)
    if (!headers.has('x-praesidium-caller')) headers.set('x-praesidium-caller', caller)
    return fetchImpl(input, { ...init, headers })
  }
  return wrapped as F
}

/**
 * The global fetch with client and caller added. The global is looked up per call, so
 * a fetch swapped in after import (tests) is the one used.
 */
export function firstPartyFetch(userAgent: string, component?: string): typeof fetch {
  const globalFetch: FetchFunction = (input, init) => fetch(input, init)
  return withUserAgent(globalFetch, userAgent, resolveCaller(component)) as typeof fetch
}

const CLIENT_TOKEN = /^([A-Za-z0-9._~+-]{1,64})\/([A-Za-z0-9._~+-]{1,64})/

/** The leading `<name>/<version>` product token of a User-Agent, else `unknown`. */
export function clientFromUserAgent(userAgent: string | null | undefined): string {
  const match = CLIENT_TOKEN.exec(userAgent?.trim() ?? '')
  return match === null ? 'unknown' : `${match[1]}/${match[2]}`
}

/** Logging L3: attribution never changes request admission. */
export function callerFromHeader(caller: string | null | undefined): string {
  if (caller === null || caller === undefined) return 'unknown'
  return caller.length >= 1 && caller.length <= 128 && !/[^A-Za-z0-9._:@/+-]/.test(caller)
    ? caller
    : 'invalid'
}

/** Service-api §3: resolve once when constructing a first-party client. */
export function resolveCaller(
  component?: string,
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY: boolean = process.stdin.isTTY === true
): string {
  return callerFromHeader(
    component ?? env['PRAESIDIUM_CALLER'] ?? env['ASP_HANDLE'] ?? (stdinIsTTY ? 'tty' : 'unknown')
  )
}
