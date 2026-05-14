import type { DeliveryRequest } from 'acp-core'

import type { DiscordAgentMessageIdentity } from './identity.js'
import {
  type RenderOptions,
  buildProgressBubble,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from './render.js'
import type { RunState } from './session-events-manager.js'
import type { DiscordInterfaceBinding, RenderBlock, RenderFrame } from './types.js'

export type FinalDeliveryWritePlan = {
  frame: RenderFrame
  chunks: string[]
}

function formatToolSummary(toolInput: Record<string, unknown>): string {
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value

  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > 0) {
      return `\`${truncate(value, 80)}\``
    }
  }

  const json = JSON.stringify(toolInput)
  return json.length > 2 ? truncate(json, 80) : ''
}

function appendDeliveryAttachments(blocks: RenderBlock[], delivery: DeliveryRequest): void {
  if (!delivery.body.attachments) {
    return
  }

  for (const attachment of delivery.body.attachments) {
    const url = attachment.url ?? attachment.path
    if (!url) continue
    blocks.push({
      t: 'media_ref',
      url,
      ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.alt ? { alt: attachment.alt } : {}),
    })
  }
}

function normalizeComparableText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function deliveryDuplicatesLastAssistantSegment(deliveryText: string, run: RunState): boolean {
  // Delivery text is expected to mirror the final assistant segment for adapters
  // that emit message_end-only output; earlier matching segments should remain visible.
  const lastAssistantText = run.assistantSegments
    .filter((segment) => segment.text.length > 0)
    .sort((left, right) => left.seq - right.seq)
    .at(-1)?.text

  return (
    lastAssistantText !== undefined &&
    normalizeComparableText(lastAssistantText) === normalizeComparableText(deliveryText)
  )
}

export function buildFinalDeliveryFrame(input: {
  delivery: DeliveryRequest
  binding?: DiscordInterfaceBinding | undefined
  run?: RunState | undefined
}): RenderFrame {
  const { delivery, binding, run } = input
  const blocks: RenderBlock[] = []

  if (run) {
    const timelineBlocks: Array<{ seq: number; block: RenderBlock }> = []
    for (const tool of run.toolExecutions) {
      timelineBlocks.push({
        seq: tool.seq,
        block: {
          t: 'tool',
          toolName: tool.toolName,
          summary: formatToolSummary(tool.input),
          input: tool.input,
          approved:
            tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined,
        },
      })
    }
    for (const notice of run.noticeEntries) {
      timelineBlocks.push({
        seq: notice.seq,
        block: {
          t: 'notice',
          level: notice.level,
          message: notice.message,
        },
      })
    }
    for (const segment of run.assistantSegments) {
      if (segment.text.length === 0) {
        continue
      }
      timelineBlocks.push({
        seq: segment.seq,
        block: { t: 'markdown', md: segment.text },
      })
    }
    blocks.push(
      ...timelineBlocks.sort((left, right) => left.seq - right.seq).map((item) => item.block)
    )
  }

  const degraded = delivery.outcome?.state === 'degraded' ? delivery.outcome : undefined

  if (degraded) {
    if (degraded.reason === 'launch_signalled') {
      const signal = 'signal' in degraded ? (degraded as { signal?: string }).signal : undefined
      blocks.push({
        t: 'markdown',
        md: signal
          ? `⏹ Run was cancelled or interrupted (signal: ${signal}).`
          : '⏹ Run was cancelled or interrupted.',
      })
    } else if (degraded.reason === 'launch_failed') {
      const exitCode =
        'exitCode' in degraded ? (degraded as { exitCode?: number }).exitCode : undefined
      blocks.push({
        t: 'markdown',
        md:
          exitCode !== undefined
            ? `❌ Agent crashed (exit code ${exitCode}). No reply produced.`
            : '❌ Agent crashed. No reply produced.',
      })
    } else {
      const details =
        'details' in degraded && typeof degraded.details === 'object' && degraded.details !== null
          ? (degraded.details as { errorMessage?: unknown })
          : undefined
      const errorMessage =
        typeof details?.errorMessage === 'string' ? details.errorMessage : undefined
      blocks.push({
        t: 'notice',
        level: 'warn',
        message:
          errorMessage !== undefined
            ? `Agent finished without producing a reply: ${errorMessage}${
                degraded.source !== undefined ? ` (source: ${degraded.source})` : ''
              }.`
            : degraded.source !== undefined
              ? `Agent finished without producing a reply (source: ${degraded.source}).`
              : 'Agent finished without producing a reply.',
      })
    }
  } else {
    const deliveryText = delivery.body.text
    if (run === undefined || !deliveryDuplicatesLastAssistantSegment(deliveryText, run)) {
      blocks.push({ t: 'markdown', md: deliveryText })
    }
  }

  appendDeliveryAttachments(blocks, delivery)

  return {
    runId: delivery.runId ?? delivery.deliveryRequestId,
    projectId: binding?.projectId ?? delivery.sessionRef.scopeRef,
    phase: 'final',
    blocks,
    updatedAt: Date.now(),
  }
}

export function planFinalDeliveryWrite(input: {
  delivery: DeliveryRequest
  binding?: DiscordInterfaceBinding | undefined
  run?: RunState | undefined
  identity: DiscordAgentMessageIdentity
  maxChars: number
  renderOptions?: RenderOptions | undefined
}): FinalDeliveryWritePlan {
  const frame = buildFinalDeliveryFrame({
    delivery: input.delivery,
    binding: input.binding,
    run: input.run,
  })
  const renderOptions: RenderOptions = {
    ...input.renderOptions,
    // Final run history is rendered as compact timeline lines; verbose tool
    // output remains a live-progress concern instead of being replayed on final delivery.
    ...(input.run !== undefined ? { compact: true } : {}),
  }
  const content = renderFrameToDiscordContent(frame, input.maxChars, renderOptions)
  const prefixedContent = `-# ${input.identity.subtext}\n${content}`
  return {
    frame,
    chunks: splitIntoChunks(prefixedContent, input.maxChars, input.renderOptions),
  }
}

export function buildProgressEditContent(input: {
  frame: RenderFrame
  identity: DiscordAgentMessageIdentity
  maxChars: number
  maxLines?: number | undefined
}): string {
  const promptPreview = input.frame.title ?? 'Progress'
  const phaseEmoji =
    input.frame.phase === 'final'
      ? '✅'
      : input.frame.phase === 'error'
        ? '❌'
        : input.frame.phase === 'permission'
          ? '🔐'
          : '⏳'
  const header = `-# ${input.identity.subtext}\n${phaseEmoji} ${promptPreview}\n`
  const bubble = buildProgressBubble(input.frame, {
    maxChars: Math.max(1, input.maxChars - header.length),
    maxLines: input.maxLines ?? 12,
  })
  return `${header}${bubble}`
}
