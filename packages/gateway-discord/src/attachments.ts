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
        const res = await fetch(ref.url, {
          headers: authToken ? { 'x-cp-token': authToken } : undefined,
        })
        if (!res.ok) return null

        const lengthHeader = res.headers.get('content-length')
        const contentLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : undefined
        if (contentLength && contentLength > maxBytes) return null

        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > maxBytes) return null

        const filename = guessFilename(ref, index)
        return new AttachmentBuilder(buffer, { name: filename })
      } catch {
        return null
      }
    })
  )

  return results.filter((item): item is AttachmentBuilder => Boolean(item))
}
