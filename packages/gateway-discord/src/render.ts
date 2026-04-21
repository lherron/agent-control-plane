import { padMarkdownTables } from './markdown.js'
import type { RenderAction, RenderBlock, RenderFrame } from './types.js'

/**
 * Options for controlling Discord rendering behavior.
 */
export interface RenderOptions {
  /**
   * When true, wrap non-code prose in block-quotes (> prefix) instead of code blocks.
   * This provides a different visual style in Discord.
   */
  useBlockQuotes?: boolean
}

/**
 * Represents an image attachment to be sent with a Discord message.
 */
export interface ImageAttachment {
  /** Base64 encoded image data */
  data: string
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: string
  /** Optional filename */
  filename?: string
}

/**
 * Represents a media reference to be fetched by the gateway.
 */
export interface MediaRefAttachment {
  url: string
  mimeType?: string
  filename?: string
  alt?: string
}

function renderBlock(block: RenderBlock): string {
  switch (block.t) {
    case 'markdown':
      return block.md
    case 'code':
      return `\`\`\`${block.lang ?? ''}\n${block.code}\n\`\`\``
    case 'image':
      // Images are rendered as attachments, just add a placeholder in text
      return '_[Image attached]_'
    case 'media_ref': {
      const label = block.filename ?? block.mimeType ?? 'media'
      // Escape underscores to prevent Discord from interpreting them as italic markers
      const escapedLabel = label.replace(/_/g, '\\_')
      return `_[Media attached: ${escapedLabel}]_`
    }
    case 'kv':
      return block.items.map((i) => `**${i.k}:** ${i.v}`).join('\n')
    case 'progress_list':
      return block.items
        .map((i) => {
          const icon = i.state === 'running' ? '⏳' : i.state === 'done' ? '✅' : '❌'
          return `${icon} ${i.text}`
        })
        .join('\n')
    case 'tool': {
      const icon = block.approved === false ? '❌' : block.approved === true ? '✅' : '⏳'
      const truncatedSummary =
        block.summary.length > 60 ? `${block.summary.slice(0, 60)}...` : block.summary
      let result = `${icon} **${block.toolName}**(${truncatedSummary})`
      if (block.output) {
        const lines = block.output.split('\n')
        const maxLines = 3
        const truncatedOutput =
          lines.length > maxLines
            ? `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
            : block.output
        result += `\n\`\`\`\n${truncatedOutput}\n\`\`\``
      }
      // Note: images are extracted separately via extractImagesFromFrame
      if (block.images && block.images.length > 0) {
        result += `\n_[${block.images.length} image${block.images.length > 1 ? 's' : ''} attached]_`
      }
      if (block.approvalSource) {
        result += `\n_Allowed by ${block.approvalSource}_`
      }
      return result
    }
  }
}

export function renderFrameToDiscordContent(frame: RenderFrame, _maxChars: number): string {
  const parts: string[] = []
  if (frame.title) parts.push(`**${frame.title}**`)
  if (frame.statusLine) parts.push(`_${frame.statusLine}_`)
  for (const block of frame.blocks) parts.push(renderBlock(block))

  return parts.filter(Boolean).join('\n\n')
}

/**
 * Get file extension from MIME type.
 */
function getExtensionForMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return mimeToExt[mimeType] || 'bin'
}

/**
 * Extract all images from a RenderFrame for use as Discord attachments.
 * Returns an array of ImageAttachment objects with base64 data and MIME types.
 */
export function extractImagesFromFrame(frame: RenderFrame): ImageAttachment[] {
  const images: ImageAttachment[] = []
  let imageIndex = 0

  for (const block of frame.blocks) {
    if (block.t === 'image') {
      const ext = getExtensionForMimeType(block.mimeType)
      images.push({
        data: block.data,
        mimeType: block.mimeType,
        filename: `image_${imageIndex++}.${ext}`,
      })
    } else if (block.t === 'tool' && block.images) {
      for (const img of block.images) {
        const ext = getExtensionForMimeType(img.mimeType)
        images.push({
          data: img.data,
          mimeType: img.mimeType,
          filename: `${block.toolName}_${imageIndex++}.${ext}`,
        })
      }
    }
  }

  return images
}

/**
 * Extract all media refs from a RenderFrame for gateway-side fetching.
 */
export function extractMediaRefsFromFrame(frame: RenderFrame): MediaRefAttachment[] {
  const mediaRefs: MediaRefAttachment[] = []

  for (const block of frame.blocks) {
    if (block.t === 'media_ref') {
      mediaRefs.push({
        url: block.url,
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        ...(block.filename !== undefined ? { filename: block.filename } : {}),
        ...(block.alt !== undefined ? { alt: block.alt } : {}),
      })
    }
  }

  return mediaRefs
}

/**
 * A segment of content: prose (to be wrapped), code block (already fenced), or table (fixed-width).
 */
interface ContentSegment {
  kind: 'prose' | 'code' | 'table'
  content: string
  lang?: string // For code blocks, the language specifier
}

/**
 * Split content into prose and code block segments.
 * Code blocks are identified by ``` fences at line boundaries.
 * This avoids matching ``` that appears inside code (like string literals).
 */
function splitByCodeFences(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  // Match code blocks where fences are at line boundaries:
  // - Opening: start of string or newline, then ```lang, then newline
  // - Closing: newline, then ```, then end of string or newline
  const codeBlockRegex = /(?:^|\n)```(\w*)\n([\s\S]*?)\n```(?=\n|$)/g

  let lastIndex = 0
  let match: RegExpExecArray | null = codeBlockRegex.exec(content)

  while (match !== null) {
    // Adjust for the leading newline if present
    const matchStart = match[0].startsWith('\n') ? match.index + 1 : match.index

    // Add prose before this code block
    if (matchStart > lastIndex) {
      const prose = content.slice(lastIndex, matchStart).trim()
      if (prose) {
        segments.push({ kind: 'prose', content: prose })
      }
    }

    // Add the code block (without the fences - we'll re-add them)
    segments.push({
      kind: 'code',
      content: match[2] ?? '',
      ...(match[1] ? { lang: match[1] } : {}),
    })

    lastIndex = match.index + match[0].length
    match = codeBlockRegex.exec(content)
  }

  // Add remaining prose after last code block
  if (lastIndex < content.length) {
    const prose = content.slice(lastIndex).trim()
    if (prose) {
      segments.push({ kind: 'prose', content: prose })
    }
  }

  return segments
}

/**
 * Check if a line is a markdown table line (starts and ends with |).
 */
function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

/**
 * Split prose content into alternating prose and table segments.
 * Tables are detected as contiguous lines that start and end with |.
 */
function splitProseByTables(prose: string): ContentSegment[] {
  const lines = prose.split('\n')
  const segments: ContentSegment[] = []
  let currentLines: string[] = []
  let inTable = false

  const flushSegment = () => {
    if (currentLines.length === 0) return
    const content = currentLines.join('\n').trim()
    if (content) {
      segments.push({
        kind: inTable ? 'table' : 'prose',
        content,
      })
    }
    currentLines = []
  }

  for (const line of lines) {
    const lineIsTable = isTableLine(line)

    if (lineIsTable !== inTable) {
      flushSegment()
      inTable = lineIsTable
    }
    currentLines.push(line)
  }
  flushSegment()

  return segments
}

/**
 * Post-process segments to split prose segments by tables.
 * Only used when useBlockQuotes is enabled.
 */
function splitSegmentsByTables(segments: ContentSegment[]): ContentSegment[] {
  return segments.flatMap((segment) => {
    if (segment.kind !== 'prose') return [segment]
    return splitProseByTables(segment.content)
  })
}

/**
 * Split a single text block into chunks that fit within maxChars.
 * Splits at newline boundaries when possible.
 */
function splitTextBlock(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining)
      break
    }

    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf('\n', maxChars)
    if (splitAt <= 0) {
      // No newline found, force split at maxChars
      splitAt = maxChars
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  return chunks
}

/**
 * Escape triple backticks inside content that will be wrapped in a code block.
 * Uses unicode REVERSED PRIME (U+2035) which looks similar to backtick.
 * This prevents the content from prematurely closing the Discord code block.
 */
function escapeInnerBackticks(content: string): string {
  // Replace ``` with ‵‵‵ (reversed primes look like backticks)
  return content.replace(/```/g, '‵‵‵')
}

/**
 * Wrap content as a Discord block-quote by prefixing each line with "> ".
 * Empty lines get "> " (with space) to maintain the quote block continuity.
 */
function wrapAsBlockQuote(content: string): string {
  return content
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * Split content into chunks that fit within Discord's message limit.
 * Prose sections are wrapped in code blocks (default) or block-quotes; existing code blocks are preserved.
 */
export function splitIntoChunks(
  content: string,
  maxChars: number,
  options: RenderOptions = {}
): string[] {
  const { useBlockQuotes = false } = options
  let segments = splitByCodeFences(content)

  // When using block quotes, further split prose by tables so tables get code blocks
  if (useBlockQuotes) {
    segments = splitSegmentsByTables(segments)
  }

  const chunks: string[] = []

  for (const segment of segments) {
    if (segment.kind === 'code') {
      // Code blocks: escape inner backticks, wrap with fences, then split if needed
      const lang = segment.lang ?? ''
      const fenceOverhead = 3 + lang.length + 1 + 3 + 1 // ```lang\n + \n```
      const maxCodeContent = maxChars - fenceOverhead

      const escapedContent = escapeInnerBackticks(segment.content)
      const codeChunks = splitTextBlock(escapedContent, maxCodeContent)
      for (const codeChunk of codeChunks) {
        chunks.push(`\`\`\`${lang}\n${codeChunk}\n\`\`\``)
      }
    } else if (segment.kind === 'table') {
      // Tables: pad for alignment and wrap in code block for fixed-width display
      const paddedTable = padMarkdownTables(segment.content)
      const fenceOverhead = 4 + 4 // ```\n + \n```
      const maxTableContent = maxChars - fenceOverhead

      const tableChunks = splitTextBlock(paddedTable, maxTableContent)
      for (const tableChunk of tableChunks) {
        chunks.push(`\`\`\`\n${tableChunk}\n\`\`\``)
      }
    } else if (useBlockQuotes) {
      // Prose: wrap as block-quotes ("> " prefix per line)
      // Overhead is 2 chars per line ("> "), estimate based on average line length
      // Use a conservative estimate: assume average line is ~60 chars, so ~3% overhead
      const estimatedOverhead = Math.ceil(segment.content.length * 0.04)
      const maxProseContent = maxChars - estimatedOverhead

      const proseChunks = splitTextBlock(segment.content, maxProseContent)
      for (const proseChunk of proseChunks) {
        chunks.push(wrapAsBlockQuote(proseChunk))
      }
    } else {
      // Prose: wrap in plain code block for monospace display
      const fenceOverhead = 4 + 4 // ```\n + \n```
      const maxProseContent = maxChars - fenceOverhead

      const proseChunks = splitTextBlock(segment.content, maxProseContent)
      for (const proseChunk of proseChunks) {
        chunks.push(`\`\`\`\n${proseChunk}\n\`\`\``)
      }
    }
  }

  return chunks
}

export function renderActionsToCustomIds(
  projectId: string,
  runId: string,
  actions?: RenderAction[]
) {
  // Discord customIds are limited to 100 chars, so use short versions
  const shortRunId = runId.slice(0, 8)
  return (actions ?? []).map((a) => ({
    action: a,
    // Format: run:{projectId}:{shortRunId}:{actionId}
    // Keep under 100 chars total
    customId: `run:${projectId}:${shortRunId}:${a.id}`.slice(0, 100),
  }))
}
