import type { DashboardEvent } from 'acp-ops-projection'
import { clockLabel } from './time'

export const DETAIL_EVENT_LIMIT = 40

export function sortedEvents(events: DashboardEvent[]): DashboardEvent[] {
  return [...events].sort((left, right) => {
    const leftTs = Date.parse(left.ts)
    const rightTs = Date.parse(right.ts)
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return leftTs - rightTs
    }
    return left.hrcSeq - right.hrcSeq
  })
}

export function mergeEvents(left: DashboardEvent[], right: DashboardEvent[]): DashboardEvent[] {
  const byId = new Map<string, DashboardEvent>()
  for (const event of left) byId.set(event.id, event)
  for (const event of right) byId.set(event.id, event)
  return sortedEvents([...byId.values()])
}

export function shortJson(value: unknown, maxLength = 240): string {
  if (value === undefined) return ''
  const rendered =
    typeof value === 'string'
      ? value
      : JSON.stringify(value, null, typeof value === 'object' ? 2 : 0)
  if (rendered.length <= maxLength) return rendered
  return `${rendered.slice(0, maxLength - 1)}...`
}

export function previewRecord(event: DashboardEvent): Record<string, unknown> {
  return event.payloadPreview && typeof event.payloadPreview === 'object'
    ? (event.payloadPreview as Record<string, unknown>)
    : {}
}

export function payloadPreview(event: DashboardEvent, maxLength = 120): string {
  const preview = previewRecord(event)
  if (preview['message'] !== undefined) return shortJson(preview['message'], maxLength)
  if (preview['preview'] !== undefined) return shortJson(preview['preview'], maxLength)
  if (preview['input'] !== undefined) return shortJson(preview['input'], maxLength)
  if (preview['result'] !== undefined) return shortJson(preview['result'], maxLength)
  if (preview['shortDetail'] !== undefined) return shortJson(preview['shortDetail'], maxLength)
  return shortJson(preview, maxLength)
}

export function eventTooltip(event: DashboardEvent): string {
  const preview = previewRecord(event)
  const lines = [
    `${clockLabel(event.ts)} · ${event.eventKind}`,
    `hrcSeq ${event.hrcSeq} · ${event.family} · ${event.severity}`,
  ]

  if (typeof preview['toolName'] === 'string') lines.push(`tool ${preview['toolName']}`)
  if (preview['input'] !== undefined) lines.push(`params ${shortJson(preview['input'])}`)
  if (preview['result'] !== undefined) lines.push(`result ${shortJson(preview['result'])}`)
  if (event.shortDetail) lines.push(event.shortDetail)

  return lines.join('\n')
}

export type StreamCardKind = 'tool' | 'message' | 'runtime' | 'warning' | 'event'

export function streamCardKind(event: DashboardEvent): StreamCardKind {
  if (event.family === 'tool') return 'tool'
  if (event.family === 'agent_message') return 'message'
  if (event.family === 'warning' || event.severity === 'warning' || event.severity === 'error') {
    return 'warning'
  }
  if (event.family === 'runtime' || event.family === 'delivery' || event.family === 'handoff') {
    return 'runtime'
  }
  return 'event'
}

export function streamCardTitle(event: DashboardEvent): string {
  const preview = previewRecord(event)
  if (streamCardKind(event) === 'tool') {
    const name = typeof preview['toolName'] === 'string' ? preview['toolName'] : 'tool'
    return event.eventKind.includes('end') ? `${name} completed` : `${name} started`
  }
  if (streamCardKind(event) === 'message') {
    const role = typeof preview['role'] === 'string' ? preview['role'] : 'agent'
    return `${role} message`
  }
  return event.label ?? event.eventKind
}
