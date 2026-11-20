/**
 * The one loopback-upstream guard for mobile proxies (jobhunt's bespoke routes and
 * the plugin-page asset proxy): an upstream is a loopback HTTP(S) origin without
 * credentials, each request is a single hop with no redirect handling, pooling or
 * retry, it carries the server-owned `user:lance` principal and only the headers the
 * caller names, and a fixed deadline bounds it.
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { isLoopbackPeer } from './routing/peer.js'

export const UPSTREAM_PRINCIPAL = 'user:lance'

/** The reason `url` is not an acceptable upstream, or `undefined` when it is. */
export function loopbackUpstreamRefusal(url: URL): string | undefined {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.hostname !== 'localhost' && !isLoopbackPeer({ address: url.hostname })) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return 'upstream must name a loopback HTTP host without credentials'
  }
  return undefined
}

export type UpstreamRequest = {
  base: URL
  path: string
  method: string
  headers: Record<string, string>
  body?: Buffer | undefined
  deadlineMs: number
}

export type UpstreamResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer }

function send(
  input: UpstreamRequest,
  onResponse: (res: IncomingMessage, settle: (error?: Error) => void) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const settle = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const request = input.base.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      {
        protocol: input.base.protocol,
        hostname: input.base.hostname.replace(/^\[|\]$/g, ''),
        port: input.base.port || undefined,
        method: input.method,
        path: input.path,
        agent: false,
        headers: { ...input.headers, 'X-Principal': UPSTREAM_PRINCIPAL },
      },
      (res) => {
        res.on('error', settle)
        onResponse(res, settle)
      }
    )
    const timer = setTimeout(() => {
      const error = new Error('upstream deadline exceeded')
      settle(error)
      req.destroy(error)
    }, input.deadlineMs)
    req.on('error', settle)
    req.end(input.body)
  })
}

/** One request whose deadline covers the whole response, which is buffered. */
export async function upstreamHop(input: UpstreamRequest): Promise<UpstreamResponse> {
  let response: UpstreamResponse | undefined
  await send(input, (res, settle) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => {
      response = {
        status: res.statusCode ?? 502,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }
      settle()
    })
  })
  return response as UpstreamResponse
}

/**
 * One request whose deadline covers the response head; the body streams to the
 * caller and is destroyed when the caller cancels it.
 */
export async function upstreamStream(
  input: UpstreamRequest
): Promise<{ status: number; headers: IncomingHttpHeaders; body: ReadableStream<Uint8Array> }> {
  let head: IncomingMessage | undefined
  await send(input, (res, settle) => {
    head = res
    settle()
  })
  const res = head as IncomingMessage
  let open = true
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      res.on('data', (chunk: Buffer) => {
        if (open) controller.enqueue(new Uint8Array(chunk))
      })
      res.on('end', () => {
        if (open) controller.close()
        open = false
      })
      res.on('error', (error) => {
        if (open) controller.error(error)
        open = false
      })
    },
    cancel() {
      open = false
      res.destroy()
    },
  })
  return { status: res.statusCode ?? 502, headers: res.headers, body }
}
