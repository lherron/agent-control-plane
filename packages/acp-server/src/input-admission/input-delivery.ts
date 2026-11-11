import { basename } from 'node:path'
import type { AttachmentRef } from 'acp-core'
import { resolveAttachmentRefs, spooledAttachmentUrl } from '../attachments.js'
import type { ResolvedAcpServerDeps } from '../deps.js'
import type { AdmitInput } from './input-admission-service.js'

export type PreparedInputDelivery = {
  content: string
  resolvedAttachments?: AttachmentRef[] | undefined
}

function appendAttachmentContext(
  content: string,
  entries: Array<{
    source: AttachmentRef
    resolved?: AttachmentRef | undefined
  }>,
  discordMessageId?: string | undefined,
  spool: { baseUrl?: string | undefined; stateDir?: string | undefined } = {}
): string {
  if (entries.length === 0) {
    return content
  }

  if (discordMessageId !== undefined) {
    const lines = entries.map(({ source, resolved }) => {
      const contentType = source.contentType ?? resolved?.contentType ?? 'application/octet-stream'
      if (resolved?.path === undefined) {
        const filename = source.filename ?? resolved?.filename ?? 'attachment'
        return `Attachment unavailable: ${filename} (${contentType}, discord message ${discordMessageId})`
      }

      // wrkc envelopes are durable while Discord CDN URLs are signed and
      // short-lived, so only ACP's spooled copy enters presented body text.
      // The path only resolves on the ACP node; a seat placed elsewhere (svc)
      // fetches the same file from ACP's media route (T-12176). The hint writes
      // to $TMPDIR, never the seat's cwd, which is usually a repo checkout.
      // Path/filename, type, and Discord source id remain meaningful metadata
      // even if a later retention policy has aged the spool file out.
      const line = `Attachment: ${resolved.path} (${contentType}, discord message ${discordMessageId})`
      const url = spooledAttachmentUrl(spool.baseUrl, spool.stateDir, resolved.path)
      if (url === undefined) {
        return line
      }
      return `${line}\n  from another node: curl -fsS '${url}' -o "\${TMPDIR:-/tmp}/${basename(resolved.path)}"`
    })
    return `${content}\n\n${lines.join('\n')}`
  }

  const sections = entries.map(({ source, resolved }, index) => {
    const filename = source.filename ?? resolved?.filename
    const contentType = source.contentType ?? resolved?.contentType
    const sizeBytes = source.sizeBytes ?? resolved?.sizeBytes
    return [
      `[attachment ${index + 1}]`,
      ...(filename !== undefined ? [`filename: ${filename}`] : []),
      ...(contentType !== undefined ? [`content_type: ${contentType}`] : []),
      ...(sizeBytes !== undefined ? [`size_bytes: ${sizeBytes}`] : []),
      ...(source.url !== undefined ? [`source_url: ${source.url}`] : []),
      ...(source.path !== undefined ? [`source_path: ${source.path}`] : []),
      ...(resolved?.path !== undefined ? [`local_path: ${resolved.path}`] : []),
    ].join('\n')
  })

  return `${content}\n\n${sections.join('\n\n')}`
}

function discordMessageIdFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const interfaceSource = metadata?.['interfaceSource']
  if (
    typeof interfaceSource !== 'object' ||
    interfaceSource === null ||
    Array.isArray(interfaceSource)
  ) {
    return undefined
  }

  const messageRef = (interfaceSource as Readonly<Record<string, unknown>>)['messageRef']
  if (typeof messageRef !== 'string' || !messageRef.startsWith('discord:message:')) {
    return undefined
  }

  const messageId = messageRef.slice('discord:message:'.length)
  return /^[a-zA-Z0-9_-]+$/.test(messageId) ? messageId : undefined
}

export function metadataWithResolvedAttachments(
  metadata: Readonly<Record<string, unknown>> | undefined,
  resolvedAttachments: AttachmentRef[] | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (resolvedAttachments === undefined) {
    return metadata
  }
  return {
    ...(metadata ?? {}),
    resolvedAttachments,
  }
}

export async function prepareInputDelivery(
  deps: ResolvedAcpServerDeps,
  input: Pick<AdmitInput, 'attachments' | 'content' | 'metadata'>,
  inputAttemptId: string
): Promise<PreparedInputDelivery> {
  if (input.attachments === undefined || input.attachments.length === 0) {
    return { content: input.content }
  }

  const entries: Array<{
    source: AttachmentRef
    resolved?: AttachmentRef | undefined
  }> = []
  const resolvedAttachments: AttachmentRef[] = []
  const discordMessageId = discordMessageIdFromMetadata(input.metadata)

  for (const [index, source] of input.attachments.entries()) {
    // Discord attachments share a message-keyed spool directory so a body
    // reference can be traced directly to durable ingress. Other callers
    // retain the attempt-scoped fallback. The attempt is minted first, so an
    // idempotent replay returns its prior admission without re-downloading.
    const resolved = (
      await resolveAttachmentRefs([source], {
        runId: discordMessageId ?? `${inputAttemptId}-${index + 1}`,
        stateDir: deps.mediaStateDir,
        maxBytes: deps.attachmentMaxBytes,
        fetchImpl: deps.attachmentFetchImpl,
      })
    )?.[0]
    entries.push({ source, ...(resolved !== undefined ? { resolved } : {}) })
    if (resolved !== undefined) {
      resolvedAttachments.push(resolved)
    }
  }

  return {
    content: appendAttachmentContext(input.content, entries, discordMessageId, {
      baseUrl: deps.attachmentBaseUrl,
      stateDir: deps.mediaStateDir,
    }),
    ...(resolvedAttachments.length > 0 ? { resolvedAttachments } : {}),
  }
}
