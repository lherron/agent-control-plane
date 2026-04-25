import { access, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AttachmentRef } from 'acp-core'

export const DEFAULT_INTERFACE_MEDIA_STATE_DIR =
  process.env['ACP_MEDIA_STATE_DIR'] ?? join(process.cwd(), 'packages/acp-server/state')
export const DEFAULT_INTERFACE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

const MEDIA_SUBDIR = 'media'
const ATTACHMENTS_SUBDIR = 'attachments'

type FetchLike = typeof fetch

export interface ResolveAttachmentRefsOptions {
  stateDir?: string | undefined
  runId: string
  maxBytes?: number | undefined
  fetchImpl?: FetchLike | undefined
}

type DownloadedAttachment = {
  path: string
  filename: string
  contentType?: string | undefined
  sizeBytes: number
}

export async function resolveAttachmentRefs(
  attachments: AttachmentRef[] | undefined,
  options: ResolveAttachmentRefsOptions
): Promise<AttachmentRef[] | undefined> {
  if (attachments === undefined || attachments.length === 0) {
    return undefined
  }

  const resolved: AttachmentRef[] = []
  for (const attachment of attachments) {
    try {
      const next = await resolveAttachmentRef(attachment, options)
      if (next !== undefined) {
        resolved.push(next)
      }
    } catch (error) {
      logAttachmentWarning('attachments.resolve.failed', 'Attachment resolution failed', {
        runId: options.runId,
        attachment,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return resolved.length > 0 ? resolved : undefined
}

async function resolveAttachmentRef(
  attachment: AttachmentRef,
  options: ResolveAttachmentRefsOptions
): Promise<AttachmentRef | undefined> {
  if (attachment.kind === 'file') {
    return resolveFileAttachment(attachment, options)
  }

  const filePath = normalizeFilePath(attachment.url)
  if (filePath !== undefined) {
    return resolveFileAttachment({ ...attachment, kind: 'file', path: filePath }, options)
  }

  if (attachment.url === undefined) {
    logAttachmentWarning('attachments.resolve.missing_url', 'URL attachment is missing a URL', {
      runId: options.runId,
      attachment,
    })
    return undefined
  }

  if (!isHttpUrl(attachment.url)) {
    logAttachmentWarning('attachments.resolve.unsupported_url', 'Attachment URL is not http(s)', {
      runId: options.runId,
      url: attachment.url,
    })
    return undefined
  }

  const downloaded = await downloadUrlAttachment(attachment, options)
  if (downloaded === undefined) {
    return undefined
  }

  return {
    kind: 'file',
    path: downloaded.path,
    filename: downloaded.filename,
    ...(downloaded.contentType !== undefined ? { contentType: downloaded.contentType } : {}),
    sizeBytes: downloaded.sizeBytes,
  }
}

async function resolveFileAttachment(
  attachment: AttachmentRef,
  options: ResolveAttachmentRefsOptions
): Promise<AttachmentRef | undefined> {
  const filePath = normalizeFilePath(attachment.path ?? attachment.url)
  if (filePath === undefined) {
    logAttachmentWarning(
      'attachments.resolve.missing_file_path',
      'File attachment path is missing or not absolute',
      {
        runId: options.runId,
        attachment,
      }
    )
    return undefined
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(filePath)
  } catch {
    logAttachmentWarning(
      'attachments.resolve.file_missing',
      'Attachment file path does not exist',
      {
        runId: options.runId,
        path: filePath,
      }
    )
    return undefined
  }

  if (!stats.isFile()) {
    logAttachmentWarning('attachments.resolve.not_file', 'Attachment path is not a regular file', {
      runId: options.runId,
      path: filePath,
    })
    return undefined
  }

  const maxBytes = resolveMaxBytes(options.maxBytes)
  if (stats.size > maxBytes) {
    logAttachmentWarning(
      'attachments.resolve.file_too_large',
      'Attachment file exceeds max bytes',
      {
        runId: options.runId,
        path: filePath,
        sizeBytes: stats.size,
        maxBytes,
      }
    )
    return undefined
  }

  return {
    kind: 'file',
    path: filePath,
    ...(attachment.filename !== undefined
      ? { filename: sanitizeFilename(attachment.filename) }
      : {}),
    ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
    sizeBytes: attachment.sizeBytes ?? stats.size,
  }
}

async function downloadUrlAttachment(
  attachment: AttachmentRef,
  options: ResolveAttachmentRefsOptions
): Promise<DownloadedAttachment | undefined> {
  const url = attachment.url
  if (url === undefined) {
    return undefined
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    logAttachmentWarning('attachments.download.failed', 'Failed to fetch attachment URL', {
      runId: options.runId,
      url,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }

  if (!response.ok) {
    logAttachmentWarning('attachments.download.bad_status', 'Attachment download returned non-OK', {
      runId: options.runId,
      url,
      status: response.status,
    })
    return undefined
  }

  if (response.body === null) {
    logAttachmentWarning(
      'attachments.download.no_body',
      'Attachment download response has no body',
      {
        runId: options.runId,
        url,
      }
    )
    return undefined
  }

  const maxBytes = resolveMaxBytes(options.maxBytes)
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== undefined && contentLength > maxBytes) {
    logAttachmentWarning(
      'attachments.download.content_length_too_large',
      'Attachment content-length exceeds max bytes',
      {
        runId: options.runId,
        url,
        sizeBytes: contentLength,
        maxBytes,
      }
    )
    return undefined
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined
  const derivedName = deriveAttachmentName(attachment, response.headers.get('content-disposition'))
  const filename = ensureExtension(sanitizeFilename(derivedName ?? 'attachment'), contentType)
  const chunks: Uint8Array[] = []
  let sizeBytes = 0
  const reader = response.body.getReader()

  try {
    while (true) {
      const read = await reader.read()
      if (read.done) {
        break
      }
      sizeBytes += read.value.byteLength
      if (sizeBytes > maxBytes) {
        logAttachmentWarning(
          'attachments.download.body_too_large',
          'Attachment body exceeds max bytes',
          {
            runId: options.runId,
            url,
            sizeBytes,
            maxBytes,
          }
        )
        await reader.cancel()
        return undefined
      }
      chunks.push(read.value)
    }
  } finally {
    reader.releaseLock()
  }

  const attachmentsDir = join(
    options.stateDir ?? DEFAULT_INTERFACE_MEDIA_STATE_DIR,
    MEDIA_SUBDIR,
    ATTACHMENTS_SUBDIR,
    options.runId
  )
  await mkdir(attachmentsDir, { recursive: true })
  const filePath = await uniqueAttachmentPath(attachmentsDir, filename)
  await writeFile(filePath, Buffer.concat(chunks, sizeBytes))

  console.info(
    JSON.stringify({
      event: 'attachments.downloaded',
      message: 'Attachment downloaded',
      runId: options.runId,
      url,
      path: filePath,
      sizeBytes,
    })
  )

  return {
    path: filePath,
    filename,
    ...(contentType !== undefined ? { contentType } : {}),
    sizeBytes,
  }
}

function normalizeFilePath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed)
    } catch {
      return undefined
    }
  }

  return trimmed.startsWith('/') ? trimmed : undefined
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function sanitizeFilename(value: string): string {
  const base = basename(value.trim()) || 'attachment'
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  const normalized =
    sanitized.length > 0 && sanitized !== '.' && sanitized !== '..' ? sanitized : 'attachment'
  return normalized.slice(0, 160)
}

function deriveAttachmentName(
  attachment: AttachmentRef,
  contentDisposition: string | null
): string | undefined {
  if (attachment.filename !== undefined) {
    return attachment.filename
  }

  if (contentDisposition !== null) {
    const dispositionName = parseContentDispositionFilename(contentDisposition)
    if (dispositionName !== undefined) {
      return dispositionName
    }
  }

  if (attachment.url !== undefined) {
    try {
      const pathBase = basename(new URL(attachment.url).pathname)
      if (pathBase.length > 0) {
        return pathBase
      }
    } catch {
      return undefined
    }
  }

  return undefined
}

function parseContentDispositionFilename(value: string): string | undefined {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1] !== undefined) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const asciiMatch = value.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1]
}

function ensureExtension(filename: string, contentType: string | undefined): string {
  if (extname(filename) !== '') {
    return filename
  }

  return `${filename}${extensionFromContentType(contentType)}`
}

export function ensureAttachmentExtension(
  filename: string,
  contentType: string | undefined
): string {
  return ensureExtension(filename, contentType)
}

export function contentTypeFromFilename(filename: string): string | undefined {
  switch (extname(filename).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.pdf':
      return 'application/pdf'
    case '.json':
      return 'application/json'
    case '.txt':
      return 'text/plain'
    default:
      return undefined
  }
}

export function extensionFromContentType(contentType: string | undefined): string {
  switch (contentType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    case 'application/pdf':
      return '.pdf'
    case 'application/json':
      return '.json'
    case 'text/plain':
      return '.txt'
    default:
      return ''
  }
}

async function uniqueAttachmentPath(directory: string, filename: string): Promise<string> {
  const extension = extname(filename)
  const stem = extension === '' ? filename : filename.slice(0, -extension.length)

  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? filename : `${stem}-${index}${extension}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }

  throw new Error(`could not allocate attachment filename for ${filename}`)
}

export async function uniqueStoredAttachmentPath(
  directory: string,
  filename: string
): Promise<string> {
  return uniqueAttachmentPath(directory, filename)
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function resolveMaxBytes(configured: number | undefined): number {
  if (configured !== undefined) {
    return configured
  }

  const fromEnv = Number.parseInt(process.env['ACP_ATTACHMENT_MAX_BYTES'] ?? '', 10)
  return Number.isSafeInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_INTERFACE_ATTACHMENT_MAX_BYTES
}

export function resolveAttachmentMaxBytes(configured: number | undefined): number {
  return resolveMaxBytes(configured)
}

function logAttachmentWarning(
  event: string,
  message: string,
  data: Readonly<Record<string, unknown>>
): void {
  console.warn(JSON.stringify({ event, message, ...data }))
}
