import {
  extractEventPreview,
  formatEventPreviewLine,
  formatNoticeLine,
  formatToolLine,
  getHrcEventIcon,
  getToolEmoji,
  truncateText,
} from 'agent-action-render'

import type { HrcEvent } from '../hrc-store-reader.js'
import { asRecord, stringField } from './json-narrow.js'
import type { HrcDetailMode } from './timeline-hrc-join.js'
import type { HrcTimelineRow } from './timeline-project.js'

function boolField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function otelAttributes(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(asRecord(payload['otel'])['logRecord'])['attributes'])
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

function outputMetadataFromContent(payload: Record<string, unknown>): Record<string, unknown> {
  const content = asRecord(payload['result'])['content']
  if (!Array.isArray(content)) return {}
  for (const entry of content) {
    const text = stringField(asRecord(entry), 'text')
    const parsed = parseJsonObject(text)
    const metadata = asRecord(parsed?.['metadata'])
    if (Object.keys(metadata).length > 0) return metadata
  }
  return {}
}

export function hrcEventToolName(event: HrcEvent): string | undefined {
  const payload = event.eventJson
  const attrs = otelAttributes(payload)
  return (
    stringField(payload, 'toolName') ??
    stringField(payload, 'tool') ??
    stringField(payload, 'name') ??
    stringField(asRecord(payload['input']), 'toolName') ??
    stringField(attrs, 'tool_name')
  )
}

function hrcToolInput(event: HrcEvent): Record<string, unknown> | undefined {
  const payload = event.eventJson
  const input = asRecord(payload['input'])
  if (Object.keys(input).length > 0) return input
  return parseJsonObject(stringField(otelAttributes(payload), 'arguments'))
}

function resultText(payload: Record<string, unknown>): string | undefined {
  const result = asRecord(payload['result'])
  const metadata = asRecord(result['metadata'])
  const outputMetadata = outputMetadataFromContent(payload)
  const exitCode =
    numberField(payload, 'exitCode') ??
    numberField(result, 'exitCode') ??
    numberField(result, 'exit_code') ??
    numberField(metadata, 'exit_code') ??
    numberField(outputMetadata, 'exit_code')
  if (exitCode !== undefined) return `exit=${exitCode}`

  const content = result['content']
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => stringField(asRecord(entry), 'text'))
      .filter((value): value is string => value !== undefined)
      .join('\n')
    const match = /Process exited with code (\d+)/.exec(text)
    if (match?.[1] !== undefined) return `exit=${match[1]}`
  }
  return undefined
}

function formatToolEndLine(event: HrcEvent, toolName: string): string {
  const payload = event.eventJson
  const attrs = otelAttributes(payload)
  const failed =
    boolField(payload, 'isError') === true ||
    boolField(attrs, 'success') === false ||
    stringField(attrs, 'error_code') !== undefined
  const emoji = failed ? '❌' : getToolEmoji(toolName)
  const succeeded = boolField(attrs, 'success') === true || boolField(payload, 'isError') === false
  const exit = resultText(payload) ?? (succeeded ? 'ok' : undefined)
  const duration = numberField(attrs, 'duration_ms')
  const parts = [exit, duration !== undefined ? `(${Math.round(duration)}ms)` : undefined].filter(
    (part): part is string => part !== undefined
  )
  return truncateText(`${emoji} ${toolName}: ${parts.join(' ')}`.trimEnd(), 80)
}

function hrcMessageBody(event: HrcEvent): string | undefined {
  const payload = event.eventJson
  const message = asRecord(payload['message'])
  const nestedPayload = asRecord(payload['payload'])
  return (
    stringField(message, 'content') ??
    stringField(nestedPayload, 'text') ??
    stringField(payload, 'text') ??
    stringField(payload, 'content') ??
    stringField(payload, 'textDelta') ??
    stringField(nestedPayload, 'delta')
  )
}

function firstStringValue(record: Record<string, unknown>): string | undefined {
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function displayForEvent(
  event: HrcEvent,
  detail: HrcDetailMode
): {
  displayText?: string | undefined
  toolName?: string | undefined
  assistantBody?: string | undefined
  label?: string | undefined
} {
  const toolName = hrcEventToolName(event)
  if (event.eventKind === 'tool_execution_start' && toolName !== undefined) {
    return {
      displayText: formatToolLine(toolName, hrcToolInput(event), '', false),
      toolName,
    }
  }
  if (event.eventKind === 'tool_execution_end' && toolName !== undefined) {
    return {
      displayText: formatToolEndLine(event, toolName),
      toolName,
    }
  }
  if (event.eventKind === 'codex.tool_result' && toolName !== undefined) {
    return {
      displayText: formatToolEndLine(event, toolName),
      toolName,
    }
  }
  if (event.eventKind === 'codex.tool_decision' && toolName !== undefined) {
    const decision = stringField(otelAttributes(event.eventJson), 'decision')
    return {
      displayText: `${getHrcEventIcon(event.eventKind)} ${toolName}${decision !== undefined ? `: ${decision}` : ''}`,
      toolName,
    }
  }
  if (event.eventKind === 'message_end') {
    const body = hrcMessageBody(event)
    return {
      displayText: `${body !== undefined ? '🤖' : getHrcEventIcon(event.eventKind)} assistant${detail === 'summary' && body !== undefined ? `  ${truncateText(body, 80, '…')}` : ''}`,
      ...(body !== undefined ? { assistantBody: body } : {}),
    }
  }
  if (event.eventKind === 'notice') {
    return {
      displayText: formatNoticeLine(
        stringField(event.eventJson, 'level') ?? 'info',
        stringField(event.eventJson, 'message') ?? ''
      ),
    }
  }
  const attrs = otelAttributes(event.eventJson)
  const preview =
    extractEventPreview(event.eventKind, event.eventJson) ??
    stringField(attrs, 'prompt') ??
    hrcMessageBody(event) ??
    stringField(event.eventJson, 'message') ??
    stringField(event.eventJson, 'type') ??
    firstStringValue(event.eventJson)
  const icon = getHrcEventIcon(event.eventKind, {
    level: stringField(event.eventJson, 'level'),
    ...(toolName !== undefined ? { toolName } : {}),
  })
  return {
    displayText: formatEventPreviewLine({ icon, eventKind: event.eventKind, preview }),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(preview !== undefined ? { label: preview } : {}),
  }
}

export function hrcEventToTimelineRow(input: {
  event: HrcEvent
  parentParticipantRunId: string
  joinKind: HrcTimelineRow['joinKind']
  detail: HrcDetailMode
}): HrcTimelineRow {
  const display = displayForEvent(input.event, input.detail)
  return {
    ledger: 'hrc',
    parentParticipantRunId: input.parentParticipantRunId,
    hrcSeq: input.event.hrcSeq,
    ts: input.event.ts,
    eventKind: input.event.eventKind,
    ...(display.label !== undefined ? { label: display.label } : {}),
    ...(display.displayText !== undefined ? { displayText: display.displayText } : {}),
    ...(display.toolName !== undefined ? { toolName: display.toolName } : {}),
    ...(display.assistantBody !== undefined ? { assistantBody: display.assistantBody } : {}),
    payload: input.event.eventJson,
    joinKind: input.joinKind,
  }
}
