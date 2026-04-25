import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { AttachmentBuilder } from 'discord.js'
import { DEFAULT_MEDIA_MAX_BYTES, MEDIA_MIME_EXT } from './config.js'
import type { ImageAttachment, MediaRefAttachment } from './render.js'

function guessFilename(ref: MediaRefAttachment, index: number): string {
  if (ref.filename) return ref.filename
  try {
    const url = new URL(ref.url)
    const base = url.pathname.split('/').pop()
    if (base) return base
  } catch {
    // ignore URL parse errors
  }
  const ext = ref.mimeType ? MEDIA_MIME_EXT[ref.mimeType] : undefined
  return ext ? `media_${index}.${ext}` : `media_${index}.bin`
}

export function createDiscordAttachments(images: ImageAttachment[]): AttachmentBuilder[] {
  return images.map((img) => {
    const buffer = Buffer.from(img.data, 'base64')
    return new AttachmentBuilder(buffer, { name: img.filename ?? 'image.png' })
  })
}

export async function fetchMediaAttachments(
  mediaRefs: MediaRefAttachment[],
  authToken: string | undefined
): Promise<AttachmentBuilder[]> {
  if (mediaRefs.length === 0) return []
  const maxBytes =
    Number.parseInt(process.env['CP_DISCORD_MEDIA_MAX_BYTES'] || '', 10) || DEFAULT_MEDIA_MAX_BYTES

  const results = await Promise.all(
    mediaRefs.map(async (ref, index) => {
      try {
        const buffer = await loadMediaRefBuffer(ref, authToken, maxBytes)
        if (buffer.length > maxBytes) return null

        const filename = guessFilename(ref, index)
        return new AttachmentBuilder(buffer, {
          name: filename,
          ...(ref.alt !== undefined ? { description: ref.alt } : {}),
        })
      } catch {
        return null
      }
    })
  )

  return results.filter((item): item is AttachmentBuilder => Boolean(item))
}

async function loadMediaRefBuffer(
  ref: MediaRefAttachment,
  authToken: string | undefined,
  maxBytes: number
): Promise<Buffer> {
  if (isHttpUrl(ref.url)) {
    const res = await fetch(ref.url, {
      headers: authToken ? { 'x-cp-token': authToken } : undefined,
    })
    if (!res.ok) throw new Error(`media fetch failed with ${res.status}`)

    const lengthHeader = res.headers.get('content-length')
    const contentLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : undefined
    if (contentLength && contentLength > maxBytes) {
      throw new Error('media content-length exceeds max bytes')
    }

    return Buffer.from(await res.arrayBuffer())
  }

  const path = ref.url.startsWith('file://') ? fileURLToPath(ref.url) : ref.url
  const stats = await stat(path)
  if (!stats.isFile() || stats.size > maxBytes) {
    throw new Error('media file exceeds max bytes or is not a file')
  }

  return readFile(path)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
