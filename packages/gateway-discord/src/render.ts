export {
  MAX_LINE_CHARS,
  MAX_PREVIEW_CHARS,
  NOTICE_ICON,
  PRIMARY_ARG_KEY,
  TOOL_EMOJI,
  extractToolPreview,
  formatNoticeLine,
  formatToolLine,
  getToolEmoji,
} from 'agent-action-render'
import { MAX_LINE_CHARS, formatNoticeLine, formatToolLine } from 'agent-action-render'

import { padMarkdownTables } from './markdown.js'
import type { RenderAction, RenderBlock, RenderFrame } from './types.js'

// ---------------------------------------------------------------------------
// Local stub: notice block type. Phase 2 (T-01372) adds this to types.ts as
// part of the RenderBlock union. Once that lands, remove this stub and use the
// upstream type directly.
// ---------------------------------------------------------------------------
/** @internal notice block stub — consumed from types.ts once Phase 2 ships */
export interface NoticeBlock {
  t: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Extended block type that includes notice (until types.ts ships it). */
type ExtendedRenderBlock = RenderBlock | NoticeBlock

/**
 * Options for controlling Discord rendering behavior.
 */
export interface RenderOptions {
  /**
   * When true, wrap non-code prose in block-quotes (> prefix) instead of code blocks.
   * This provides a different visual style in Discord.
   */
  useBlockQuotes?: boolean

  /**
   * When true, suppress tool output snippets and image attachment placeholders.
   * Used during live-progress rendering where only the tool line matters.
   */
  compact?: boolean
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

// ---------------------------------------------------------------------------
// renderBlock — core block-to-string conversion
// ---------------------------------------------------------------------------

function renderBlock(block: ExtendedRenderBlock, options: RenderOptions = {}): string {
  const { compact = false } = options

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
      const failed = block.approved === false
      const toolBlock = block as Extract<RenderBlock, { t: 'tool' }> & {
        input?: Record<string, unknown>
      }
      const line = formatToolLine(block.toolName, toolBlock.input, block.summary, failed)

      if (compact) {
        return line
      }

      // Full rendering: include output and images
      let result = line
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
    case 'notice': {
      return formatNoticeLine(block.level, block.message)
    }
  }

  // Exhaustiveness fallback (future block types added to RenderBlock union)
  return ''
}

export function renderFrameToDiscordContent(
  frame: RenderFrame,
  _maxChars: number,
  options: RenderOptions = {}
): string {
  const parts: Array<{ text: string; compactRow: boolean }> = []
  const pushPart = (text: string, compactRow = false) => {
    if (text.length > 0) {
      parts.push({ text, compactRow })
    }
  }
  if (frame.title) pushPart(`**${frame.title}**`)
  if (frame.statusLine) pushPart(`_${frame.statusLine}_`)

  // Count tool/notice blocks for the 12-line cap
  const blocks = frame.blocks as ExtendedRenderBlock[]
  const toolNoticeCount = blocks.filter((b) => b.t === 'tool' || b.t === 'notice').length
  const collapsed = toolNoticeCount > DEFAULT_MAX_LINES ? toolNoticeCount - DEFAULT_MAX_LINES : 0
  let toolNoticeIndex = 0
  let collapseLineEmitted = false

  for (const block of blocks) {
    if (block.t === 'tool' || block.t === 'notice') {
      toolNoticeIndex += 1
      if (toolNoticeIndex <= collapsed) {
        // Skip oldest tool/notice blocks
        if (!collapseLineEmitted && collapsed > 0) {
          pushPart(`_... +${collapsed} earlier tools_`, options.compact === true)
          collapseLineEmitted = true
        }
        continue
      }
      pushPart(renderBlock(block, options), options.compact === true)
    } else {
      pushPart(renderBlock(block, options))
    }
  }

  return parts
    .map((part, index) => {
      if (index === 0) return part.text
      const previous = parts[index - 1]
      const separator = previous?.compactRow && part.compactRow ? '\n' : '\n\n'
      return `${separator}${part.text}`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// buildProgressBubble — live-progress edit helper
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 12
const DEFAULT_MAX_CHARS = 1900

function groupConsecutiveLines(lines: string[]): string[] {
  const grouped: string[] = []
  let previous: string | undefined
  let count = 0

  const flush = () => {
    if (previous === undefined) {
      return
    }
    if (count <= 1) {
      grouped.push(previous)
      return
    }
    const suffix = ` (×${count})`
    grouped.push(
      previous.length + suffix.length > MAX_LINE_CHARS
        ? `${previous.slice(0, MAX_LINE_CHARS - suffix.length - 3)}...${suffix}`
        : `${previous}${suffix}`
    )
  }

  for (const line of lines) {
    if (line === previous) {
      count += 1
      continue
    }
    flush()
    previous = line
    count = 1
  }
  flush()

  return grouped
}

/**
 * Build compact progress content for a live-progress Discord message edit.
 *
 * Rules:
 * - Max 12 visible tool/notice lines (combined). Excess collapses oldest into
 *   `_... +N earlier tools_`.
 * - Per-line cap: 80 chars.
 * - Total bubble cap: 1900 chars (leaves 100-char headroom under Discord 2000).
 * - Title and identity subtext are added by the caller (~170 chars reserved).
 * - Final assistant text (when present) is appended after the tool/notice list.
 *   If compact_history + assistant_text > 1900, oldest tool/notice lines are
 *   dropped first. `assistant_text` is NEVER truncated by this helper.
 */
type BubbleEntry = { kind: 'tool' | 'notice'; line: string } | { kind: 'text'; text: string }

export function buildProgressBubble(
  frame: RenderFrame,
  options: { maxChars?: number; maxLines?: number } = {}
): string {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  const entries: BubbleEntry[] = []
  for (const block of frame.blocks as ExtendedRenderBlock[]) {
    if (block.t === 'tool') {
      const failed = (block as Extract<RenderBlock, { t: 'tool' }>).approved === false
      const toolBlock = block as Extract<RenderBlock, { t: 'tool' }> & {
        input?: Record<string, unknown>
      }
      entries.push({
        kind: 'tool',
        line: formatToolLine(
          (block as Extract<RenderBlock, { t: 'tool' }>).toolName,
          toolBlock.input,
          (block as Extract<RenderBlock, { t: 'tool' }>).summary,
          failed
        ),
      })
    } else if (block.t === 'notice') {
      entries.push({ kind: 'notice', line: formatNoticeLine(block.level, block.message) })
    } else if (block.t === 'markdown') {
      entries.push({ kind: 'text', text: block.md })
    }
    // Other block types (code, image, etc.) are skipped in compact progress
  }

  const collapseConsecutiveToolNotice = (input: BubbleEntry[]): BubbleEntry[] => {
    const out: BubbleEntry[] = []
    let runStart = -1
    const flush = (endExclusive: number) => {
      if (runStart < 0) return
      const runLines = input.slice(runStart, endExclusive).map((e) => {
        if (e.kind === 'text') throw new Error('unreachable')
        return e.line
      })
      const grouped = groupConsecutiveLines(runLines)
      for (let i = 0; i < grouped.length; i++) {
        const original = input[runStart + i]
        const kind = original?.kind === 'notice' ? 'notice' : 'tool'
        out.push({ kind, line: grouped[i] ?? '' })
      }
      runStart = -1
    }
    for (let i = 0; i < input.length; i++) {
      const e = input[i]
      if (!e) continue
      if (e.kind === 'tool' || e.kind === 'notice') {
        if (runStart < 0) runStart = i
      } else {
        flush(i)
        out.push(e)
      }
    }
    flush(input.length)
    return out
  }

  let visible = collapseConsecutiveToolNotice(entries)

  let collapsedCount = 0
  const dropOldestToolNotice = (count: number): void => {
    let dropped = 0
    const next: BubbleEntry[] = []
    for (const e of visible) {
      if (dropped < count && (e.kind === 'tool' || e.kind === 'notice')) {
        dropped += 1
        continue
      }
      next.push(e)
    }
    collapsedCount += dropped
    visible = next
  }

  const toolNoticeCount = visible.filter((e) => e.kind !== 'text').length
  if (toolNoticeCount > maxLines) {
    dropOldestToolNotice(toolNoticeCount - maxLines)
  }

  const buildContent = (parts: BubbleEntry[], collapsed: number): string => {
    const lines: string[] = []
    if (collapsed > 0) {
      lines.push(`_... +${collapsed} earlier tools_`)
    }
    for (const p of parts) {
      lines.push(p.kind === 'text' ? p.text : p.line)
    }
    return lines.join('\n')
  }

  let content = buildContent(visible, collapsedCount)

  // Shave tool/notice line previews first; never touch text entries.
  while (content.length > maxChars) {
    const lineIndex = visible.findIndex(
      (e) => e.kind !== 'text' && (e as { line: string }).line.length > 40
    )
    if (lineIndex < 0) break
    const entry = visible[lineIndex]
    if (!entry || entry.kind === 'text') break
    const overBy = content.length - maxChars
    const targetLength = Math.max(40, entry.line.length - overBy)
    visible[lineIndex] = {
      kind: entry.kind,
      line:
        targetLength >= entry.line.length
          ? entry.line
          : `${entry.line.slice(0, Math.max(0, targetLength - 3))}...`,
    }
    content = buildContent(visible, collapsedCount)
  }

  // Drop more oldest tool/notice entries if still over budget.
  while (content.length > maxChars && visible.some((e) => e.kind !== 'text')) {
    dropOldestToolNotice(1)
    content = buildContent(visible, collapsedCount)
  }

  // If still over budget, only text entries remain — concatenate and truncate
  // the trailing text so the bubble fits Discord's hard limit.
  if (content.length > maxChars) {
    const collapseLine = collapsedCount > 0 ? `_... +${collapsedCount} earlier tools_\n` : ''
    const allText = visible
      .filter((e): e is { kind: 'text'; text: string } => e.kind === 'text')
      .map((e) => e.text)
      .join('\n')
    const remaining = maxChars - collapseLine.length
    content = `${collapseLine}${allText.slice(0, Math.max(0, remaining))}`
  }

  return content
}

// ---------------------------------------------------------------------------
// Image / media extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Content chunking
// ---------------------------------------------------------------------------

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
 * Prose sections render as raw markdown by default; pass useBlockQuotes to
 * wrap them in `> ` block-quotes instead. Agent-emitted fenced code blocks
 * are always preserved verbatim.
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
      // Prose: emit as-is so Discord renders markdown (bold, inline code,
      // lists, links). Agent-emitted fenced code blocks are already
      // preserved as separate `code` segments by splitByCodeFences, so this
      // branch only ever runs for actual prose.
      const proseChunks = splitTextBlock(segment.content, maxChars)
      for (const proseChunk of proseChunks) {
        chunks.push(proseChunk)
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
