/**
 * Plugin pages on the mobile gateway (hrc-ios IOS_PLUGIN_PAGES.md §2): the catalog,
 * a page's bundle, its kernel-call relay and its asset proxy. ACP is the transport and
 * owns none of the meaning: Loggia's schema reads the manifest, the phone builds whole
 * wire requests, and the installed `cardo` CLI carries them. These routes sit in the
 * ordinary mobile `bearer` class (mobile-auth/gate.ts, Lance's F1 ruling).
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { writeLogLine } from 'acp-core'

import { upstreamStream } from '../loopback-upstream.js'
import { opRefusal, parseAddress } from '../plugin-pages/allowlist.js'
import { cardoRequest } from '../plugin-pages/cardo.js'
import {
  backstopMs,
  cachedDiscovery,
  cliDeadlineSeconds,
  discoverMount,
} from '../plugin-pages/discovery.js'
import { type PluginPage, readPluginPage, readPluginPages } from '../plugin-pages/manifest.js'
import type { RouteContext, RouteHandler } from '../routing/route-context.js'

const NO_STORE = { 'cache-control': 'no-store' }
const BODY_BYTES_MAX = 64 * 1024
const ASSET_DEADLINE_MS = 10_000
const ASSET_REQUEST_HEADERS = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
]
const ASSET_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
]

/** Every refusal ACP adds has the wire's own error shape, so the phone maps one shape. */
export function relayError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status, headers: NO_STORE }
  )
}

function log(event: string, data: Record<string, unknown>): void {
  writeLogLine({ level: 'info', component: 'mobile-plugins', event, data })
}

async function pageFor(context: RouteContext): Promise<PluginPage | Response> {
  const plugin = context.params['plugin'] ?? ''
  const name = context.params['page'] ?? ''
  const page = await readPluginPage(context.deps.pluginPages, plugin, name)
  return page ?? relayError(404, 'page_not_found', `no plugin page ${plugin}:${name}`)
}

export const handleMobilePluginCatalog: RouteHandler = async ({ deps }) => {
  const options = deps.pluginPages
  const pages = await readPluginPages(options)
  const mountNames = [...new Set(pages.flatMap((page) => Object.keys(page.mounts)))]
  const discovered = new Map(
    await Promise.all(
      mountNames.map(async (mount) => [mount, await discoverMount(options, mount)] as const)
    )
  )
  const entries = pages.map((page) => ({
    id: page.id,
    title: page.title,
    icon: page.icon,
    pageRevision: page.revision,
    mounts: Object.fromEntries(
      Object.entries(page.mounts).map(([mount, { ops }]) => {
        const discovery = discovered.get(mount)
        return [
          mount,
          {
            available: discovery !== undefined,
            ops: Object.fromEntries(
              ops.map((op) => {
                const declared = discovery?.ops.get(op)
                return [
                  op,
                  declared === undefined
                    ? null
                    : {
                        ...declared,
                        deadlineSeconds:
                          backstopMs(options, cliDeadlineSeconds(options, discovery, op)) / 1000,
                      },
                ]
              })
            ),
          },
        ]
      })
    ),
  }))
  const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  return Response.json({ revision, pages: entries }, { headers: NO_STORE })
}

export const handleMobilePluginPage: RouteHandler = async (context) => {
  const page = await pageFor(context)
  if (page instanceof Response) return page
  const files = Object.fromEntries(
    [...page.files.entries()].map(([path, data]) => [path, data.toString('base64')])
  )
  return Response.json({ schema: 1, files, revision: page.revision }, { headers: NO_STORE })
}

async function readCallBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text()
  if (Buffer.byteLength(text) > BODY_BYTES_MAX) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const handleMobilePluginCall: RouteHandler = async (context) => {
  const page = await pageFor(context)
  if (page instanceof Response) return page
  const body = await readCallBody(context.request)
  const wire = body?.['request'] as Record<string, unknown> | undefined
  const address = parseAddress(body?.['mount'])
  const op = wire?.['op']
  const owner = wire?.['owner']
  if (
    address === undefined ||
    wire === null ||
    typeof wire !== 'object' ||
    typeof op !== 'string' ||
    (owner !== undefined && typeof owner !== 'string')
  ) {
    return relayError(400, 'invalid_request', 'body is {mount, request: {op, args, owner?}}')
  }
  const refusal = opRefusal(page.mounts, address.mount, op)
  if (refusal !== undefined) {
    log('plugin.call_refused', { page: page.id, mount: address.mount, op, code: refusal })
    return relayError(403, refusal, `${page.id} may not call ${op} on ${address.mount}`, {
      mount: address.mount,
      op,
    })
  }
  const options = context.deps.pluginPages
  // query and discover use the CLI's default deadline; only an op can declare its own.
  const discovery =
    op === 'graph.query' || op === 'registry.discover'
      ? undefined
      : await cachedDiscovery(options, address.mount)
  const started = performance.now()
  // `isolated` needs nothing here: every call is its own CLI process and connection.
  const outcome = await cardoRequest({
    bin: options.cardoBin,
    address: { ...address, ...(typeof owner === 'string' ? { owner } : {}) },
    request: wire,
    backstopMs: backstopMs(options, cliDeadlineSeconds(options, discovery, op)),
  })
  log('plugin.call', {
    page: page.id,
    mount: address.mount,
    op,
    outcome: outcome.kind,
    durationMs: Math.round(performance.now() - started),
  })
  switch (outcome.kind) {
    case 'reply':
      return new Response(outcome.line, {
        headers: { ...NO_STORE, 'content-type': 'application/json' },
      })
    case 'timeout':
      return relayError(
        504,
        'timeout',
        'the kernel did not answer in time',
        outcome.outcomeUnknown ? { outcome: 'unknown' } : undefined
      )
    case 'unavailable':
      return relayError(503, 'mount_unavailable', `no live mount ${address.mount}`, {
        sent: false,
      })
    case 'failed':
      writeLogLine({
        level: 'warn',
        component: 'mobile-plugins',
        event: 'plugin.call_failed',
        data: {
          page: page.id,
          mount: address.mount,
          op,
          exitCode: outcome.exitCode,
          stderr: outcome.stderr,
        },
      })
      return relayError(502, 'relay_failed', 'cardo exited without a reply', {
        exitCode: outcome.exitCode,
        outcome: 'unknown',
      })
  }
}

/**
 * `<prefix><ref>`, normalised, or `undefined` when the ref is malformed or escapes the
 * prefix. `ref` is the raw (still percent-encoded) remainder of the request path.
 */
export function assetPath(prefix: string, ref: string): string | undefined {
  let segments: string[]
  try {
    segments = ref.split('/').map((segment) => decodeURIComponent(segment))
  } catch {
    return undefined
  }
  // A decoded segment may hold `/`; split again so `..%2F` is seen as `..`.
  const decoded = segments.join('/')
  if (decoded === '' || /[\0\\]/.test(decoded)) return undefined
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  const joined = posix.normalize(base + decoded)
  if (!joined.startsWith(base)) return undefined
  return joined
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export const handleMobilePluginAsset: RouteHandler = async (context) => {
  const page = await pageFor(context)
  if (page instanceof Response) return page
  if (page.assets === undefined)
    return relayError(404, 'page_not_found', `${page.id} has no assets`)
  const marker = '/asset/'
  const ref = context.url.pathname.slice(context.url.pathname.indexOf(marker) + marker.length)
  const path = assetPath(page.assets.prefix, ref)
  if (path === undefined) {
    log('plugin.asset_refused', { page: page.id, ref })
    return relayError(400, 'invalid_asset_ref', 'asset ref must stay under the page prefix')
  }
  const headers: Record<string, string> = {}
  for (const name of ASSET_REQUEST_HEADERS) {
    const value = context.request.headers.get(name)
    if (value !== null) headers[name] = value
  }
  try {
    const upstream = await upstreamStream({
      base: new URL(page.assets.origin),
      path,
      method: context.request.method,
      headers,
      deadlineMs: ASSET_DEADLINE_MS,
    })
    const out = new Headers(NO_STORE)
    for (const name of ASSET_RESPONSE_HEADERS) {
      const value = upstream.headers[name]
      if (typeof value === 'string') out.set(name, value)
    }
    const empty = context.request.method === 'HEAD' || upstream.status === 304
    if (empty) await upstream.body.cancel()
    return new Response(empty ? null : upstream.body, { status: upstream.status, headers: out })
  } catch (error) {
    log('plugin.asset_unavailable', { page: page.id, error: String(error) })
    return relayError(503, 'asset_unavailable', 'the asset origin did not answer')
  }
}
