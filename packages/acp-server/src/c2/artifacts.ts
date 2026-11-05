/**
 * Row explanations for `GET /v1/mobile/c2/v2/artifacts/:id` (card contract
 * rev 4.1 §12.2, §5 Elucidate).
 *
 * The id is opaque to the phone: base64url JSON of `{sessionRef, rowId}`. It
 * carries no path and needs no secret, because resolution re-reads the CURRENT
 * view and takes the path only from that row's `c2.detail` (or its collapsed
 * feed item's copied `detailRef`); a forged id can name only a file the view
 * already links. Containment is checked after
 * realpath, so a symlink or `..` cannot step outside the roots. Evidence images
 * no longer exist (rev 4 §4).
 */
import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, sep } from 'node:path'

import { type ArtifactRef, type View, detailPathOf } from '@praesidium/c2-core'

export const HTML_MAX_BYTES = 64 * 1024
export const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
const HTML_TYPES = new Set(['.html', '.htm'])

type ArtifactId = { sessionRef: string; rowId: string }

export function mintArtifactId(ref: ArtifactRef): string {
  const id: ArtifactId = { sessionRef: ref.sessionRef, rowId: ref.rowId }
  return Buffer.from(JSON.stringify(id)).toString('base64url')
}

function decode(raw: string): ArtifactId | undefined {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  const v = value as Partial<ArtifactId> | null
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.sessionRef !== 'string' ||
    typeof v.rowId !== 'string'
  )
    return undefined
  return v as ArtifactId
}

function refusal(status: number, code: string): Response {
  return Response.json({ ok: false, code }, { status })
}

function realRoots(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    try {
      return [realpathSync(root)]
    } catch {
      return []
    }
  })
}

/** Resolve and serve one artifact against the current view. */
export function serveArtifact(rawId: string, view: View, roots: readonly string[]): Response {
  const id = decode(rawId)
  if (id === undefined) return refusal(400, 'invalid_artifact_id')
  // The path comes from the current view only: the shown row's c2.detail, or, once its item
  // collapsed (rev 5 F12), the detailRef the controller copied into a feed item. A changed or
  // vanished explanation invalidates the id; the client refreshes.
  const path = detailPathOf(view, id.sessionRef, id.rowId)
  if (path === undefined || !isAbsolute(path)) return refusal(404, 'artifact_missing')
  if (!HTML_TYPES.has(extname(path).toLowerCase())) return refusal(403, 'artifact_refused')

  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return refusal(404, 'artifact_missing')
  }
  const contained = realRoots(roots).some((root) =>
    real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  )
  if (!contained) return refusal(403, 'artifact_refused')

  const stat = statSync(real)
  if (!stat.isFile()) return refusal(403, 'artifact_refused')
  if (stat.size > HTML_MAX_BYTES) return refusal(413, 'artifact_too_large')

  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(stat.size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  }
  headers['content-security-policy'] = HTML_CSP
  return new Response(Bun.file(real), { status: 200, headers })
}
