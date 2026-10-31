/**
 * `GET /v1/media/attachments/:spoolId/:filename` — serves one file from the
 * inbound attachment spool so a seat placed on another node can read a Discord
 * attachment ACP downloaded (T-12176). Read-only; auth matches the other
 * non-mobile routes (loopback + tailnet bind).
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { attachmentSpoolRoot, contentTypeFromFilename, isSpoolSegment } from '../attachments.js'
import { badRequest, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetMediaAttachment: RouteHandler = async ({ params, deps }) => {
  const spoolId = params['spoolId'] ?? ''
  const filename = params['filename'] ?? ''
  // Params arrive URL-decoded, so an encoded slash or dot-dot is checked here as
  // its literal characters; the segment grammar admits neither.
  if (!isSpoolSegment(spoolId) || !isSpoolSegment(filename)) {
    badRequest('invalid attachment path', { spoolId, filename })
  }

  const filePath = join(attachmentSpoolRoot(deps.mediaStateDir), spoolId, filename)
  const stats = await stat(filePath).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) {
    notFound(`attachment not found: ${spoolId}/${filename}`, { spoolId, filename })
  }

  return new Response(Bun.file(filePath), {
    headers: {
      'content-type': contentTypeFromFilename(filename) ?? 'application/octet-stream',
      'content-length': String(stats.size),
    },
  })
}
