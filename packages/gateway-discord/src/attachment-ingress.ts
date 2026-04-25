import type { AttachmentRef, InterfaceMessageAttachment } from 'acp-core'
import type { Message } from 'discord.js'

type DiscordAttachmentLike = Pick<AttachmentRef, 'url'> & {
  name?: string | null | undefined
  filename?: string | null | undefined
  contentType?: string | null | undefined
  content_type?: string | null | undefined
  size?: number | undefined
}

type DiscordAttachmentCollectionLike = {
  values?: () => Iterable<DiscordAttachmentLike>
}

const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i

function discordAttachmentValues(attachments: unknown): DiscordAttachmentLike[] {
  const values = (attachments as DiscordAttachmentCollectionLike | undefined)?.values
  if (typeof values !== 'function') {
    return []
  }
  return Array.from(values.call(attachments))
}

function optionalNonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function optionalSizeBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function attachmentFilename(attachment: DiscordAttachmentLike): string | undefined {
  return optionalNonEmptyString(attachment.name) ?? optionalNonEmptyString(attachment.filename)
}

function attachmentContentType(attachment: DiscordAttachmentLike): string | undefined {
  return (
    optionalNonEmptyString(attachment.contentType) ??
    optionalNonEmptyString(attachment.content_type)
  )
}

function isImageAttachment(attachment: DiscordAttachmentLike): boolean {
  const contentType = attachmentContentType(attachment)
  if (contentType?.toLowerCase().startsWith('image/')) {
    return true
  }

  const filename = attachmentFilename(attachment)
  return filename !== undefined && IMAGE_EXTENSION_PATTERN.test(filename)
}

function buildAttachmentPlaceholder(attachments: DiscordAttachmentLike[]): string {
  if (attachments.length === 0) {
    return ''
  }

  const count = attachments.length
  const allImages = attachments.every(isImageAttachment)
  const tag = allImages ? '<media:image>' : '<media:document>'
  const label = allImages ? 'image' : 'file'
  const noun = count === 1 ? label : `${label}s`
  return `${tag} (${count} ${noun})`
}

export function mapDiscordMessageAttachments(
  message: Pick<Message, 'attachments'>
): InterfaceMessageAttachment[] {
  return discordAttachmentValues(message.attachments).flatMap((attachment) => {
    const url = optionalNonEmptyString(attachment.url)
    if (url === undefined) {
      return []
    }

    const filename = attachmentFilename(attachment)
    const contentType = attachmentContentType(attachment)
    const sizeBytes = optionalSizeBytes(attachment.size)

    return [
      {
        kind: 'url',
        url,
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      },
    ]
  })
}

export function resolveDiscordIngressContent(
  message: Pick<Message, 'attachments' | 'content'>
): string {
  const content = message.content.trim()
  if (content) {
    return content
  }

  return buildAttachmentPlaceholder(discordAttachmentValues(message.attachments))
}
