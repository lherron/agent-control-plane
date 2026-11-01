/**
 * Card-linked artifacts for `GET /v1/mobile/c2/artifacts/:id` (T-12207 Work
 * step 5; T-12205 r2.1 "Evidence and explanations").
 *
 * The id is opaque to the phone: base64url JSON of `{key, updatedAt, field,
 * index}`. It carries no path and needs no secret, because resolution
 * re-reads the CURRENT card and takes the path only from that authorized body;
 * a forged id can name only a file the card already links. Containment is
 * checked after realpath, so a symlink or `..` cannot step outside the roots.
 */
import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, sep } from 'node:path'

import type { ArtifactRef, CardKey, View } from '@praesidium/c2-core'

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const HTML_MAX_BYTES = 64 * 1024
export const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}
const HTML_TYPES = new Set(['.html', '.htm'])

type ArtifactId = { key: CardKey; updatedAt: string; field: 'evidence' | 'detail'; index: number }

export function mintArtifactId(ref: ArtifactRef): string {
  const id: ArtifactId = {
    key: ref.key,
    updatedAt: ref.updatedAt,
    field: ref.field,
    index: ref.index,
  }
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
  const k = v?.key as Partial<CardKey> | undefined
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.updatedAt !== 'string' ||
    (v.field !== 'evidence' && v.field !== 'detail') ||
    !Number.isInteger(v.index) ||
    (v.index as number) < 0 ||
    typeof k !== 'object' ||
    k === null ||
    typeof k.sessionRef !== 'string' ||
    !Number.isInteger(k.generation) ||
    (k.kind !== 'card' && k.kind !== 'ask') ||
    typeof k.id !== 'string'
  ) {
    return undefined
  }
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

  const entry = view.entries.find(
    (candidate) =>
      candidate.visible &&
      candidate.card.key.sessionRef === id.key.sessionRef &&
      candidate.card.key.generation === id.key.generation &&
      candidate.card.key.kind === id.key.kind &&
      candidate.card.key.id === id.key.id
  )
  // A changed or vanished card invalidates the id; the client refreshes.
  if (entry === undefined || entry.card.updatedAt !== id.updatedAt) {
    return refusal(409, 'artifact_stale')
  }

  const path =
    id.field === 'evidence'
      ? entry.card.evidence[id.index]?.image?.path
      : id.index === 0
        ? entry.card.detail.path
        : undefined
  if (path === undefined || !isAbsolute(path)) return refusal(403, 'artifact_refused')

  const ext = extname(path).toLowerCase()
  const html = id.field === 'detail'
  const contentType = html
    ? HTML_TYPES.has(ext)
      ? 'text/html; charset=utf-8'
      : undefined
    : IMAGE_TYPES[ext]
  if (contentType === undefined) return refusal(403, 'artifact_refused')

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
  if (stat.size > (html ? HTML_MAX_BYTES : IMAGE_MAX_BYTES))
    return refusal(413, 'artifact_too_large')

  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(stat.size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  }
  if (html) headers['content-security-policy'] = HTML_CSP
  return new Response(Bun.file(real), { status: 200, headers })
}
