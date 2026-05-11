import { renderMarkdownBlock } from 'agent-action-render'
import chalk from 'chalk'

import type {
  AcpTimelineRow,
  HrcTimelineRow,
  TaskTimelineProjection,
  TimelineRow,
} from './timeline-project.js'

export type TimelineRenderOptions = {
  verbose?: boolean | undefined
  markdown?: boolean | undefined
  plain?: boolean | undefined
  color?: boolean | undefined
  width?: number | undefined
  hrcDetail?: 'summary' | 'events' | 'full' | undefined
}

type ResolvedTimelineRenderOptions = {
  verbose: boolean
  markdown: boolean
  plain: boolean
  color: boolean
  width: number
  hrcDetail: 'summary' | 'events' | 'full'
}

function maybeColor(enabled: boolean, fn: (value: string) => string, value: string): string {
  return enabled ? fn(value) : value
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ''
  if (value.length <= width) return value
  if (width === 1) return '…'
  return `${value.slice(0, width - 1)}…`
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width, ' ')
}

function timeOf(ts: string | undefined): string {
  if (ts === undefined) return '—'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().slice(11, 19)
}

function spanOf(first: string | undefined, last: string | undefined): string {
  if (first === undefined || last === undefined) return '—'
  const start = new Date(first).getTime()
  const end = new Date(last).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  const ms = Math.max(0, end - start)
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function roleLine(projection: TaskTimelineProjection): string {
  const roles = Object.entries(projection.task.roleBindings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, actor]) => `${role}=${actor === null ? 'unbound' : actor.id}`)
  return roles.length > 0 ? roles.join(' · ') : 'none'
}

function isAcpRow(row: TimelineRow): row is AcpTimelineRow {
  return row.ledger === 'acp'
}

function isLastHrcRow(rows: readonly TimelineRow[], index: number, row: HrcTimelineRow): boolean {
  const next = rows[index + 1]
  return next?.ledger !== 'hrc' || next.parentParticipantRunId !== row.parentParticipantRunId
}

function symbolFor(row: AcpTimelineRow, plain: boolean): string {
  if (plain) {
    if (row.kind === 'rejected') return '[x]'
    if (row.category === 'run') return '[>]'
    if (row.category === 'mapping' || row.category === 'effect') return '[*]'
    if (row.category === 'obligation') return '[o]'
    if (row.category === 'anomaly') return '[!]'
    return '[+]'
  }
  if (row.kind === 'rejected') return '✗'
  if (row.category === 'run') return '▶'
  if (row.category === 'mapping' || row.category === 'effect') return '◆'
  if (row.category === 'obligation') return '◇'
  if (row.category === 'anomaly') return '⚠'
  return '●'
}

function styledSymbol(
  row: AcpTimelineRow,
  options: Pick<ResolvedTimelineRenderOptions, 'plain' | 'color'>
): string {
  const symbol = symbolFor(row, options.plain)
  if (!options.color) return symbol
  if (row.kind === 'rejected') return chalk.red(symbol)
  if (row.category === 'run') return chalk.cyan(symbol)
  if (row.category === 'mapping' || row.category === 'effect') return chalk.blue(symbol)
  if (row.category === 'obligation') return chalk.gray(symbol)
  if (row.category === 'anomaly') return chalk.yellow(symbol)
  return chalk.green(symbol)
}

function actorText(row: AcpTimelineRow): string {
  if (row.actor === undefined) return '—'
  return `${row.actor.id}${row.role !== undefined ? `/${row.role}` : ''}`
}

function payloadRecord(row: AcpTimelineRow): Record<string, unknown> {
  return typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
    ? (row.payload as Record<string, unknown>)
    : {}
}

function stringPayload(row: AcpTimelineRow, field: string): string | undefined {
  const value = payloadRecord(row)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nestedPayloadRecord(row: AcpTimelineRow, field: string): Record<string, unknown> {
  const value = payloadRecord(row)[field]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nestedStringPayload(
  row: AcpTimelineRow,
  objectField: string,
  field: string
): string | undefined {
  const value = nestedPayloadRecord(row, objectField)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function rowEventText(row: AcpTimelineRow, plain: boolean): string {
  const refs = row.refs.filter((ref) => !ref.startsWith('scope:'))
  const arrow = plain ? '->' : '→'
  if (row.category === 'transition') {
    const from = payloadRecord(row)['from']
    const to = payloadRecord(row)['to']
    const fromPhase =
      typeof from === 'object' && from !== null
        ? stringPayload({ ...row, payload: from }, 'phase')
        : undefined
    const toPhase =
      typeof to === 'object' && to !== null
        ? stringPayload({ ...row, payload: to }, 'phase')
        : undefined
    const transition =
      stringPayload(row, 'transitionId') ??
      nestedStringPayload(row, 'command', 'transitionId') ??
      refs[0]
    const detail =
      fromPhase !== undefined && toPhase !== undefined
        ? `${fromPhase}${arrow}${toPhase}`
        : transition
    return `${row.type}${detail !== undefined ? ` ${detail}` : ''}`
  }
  if (row.category === 'evidence') {
    const kind = stringPayload(row, 'kind') ?? stringPayload(row, 'evidenceKind') ?? refs[0]
    return `${row.type}${kind !== undefined ? ` ${kind}` : ''}`
  }
  if (row.category === 'run') {
    const runId = stringPayload(row, 'runId') ?? row.refs.find((ref) => ref.startsWith('prun_'))
    return `${row.type}${runId !== undefined ? ` ${runId}` : ''}`
  }
  if (row.category === 'mapping') {
    const hrcRun = stringPayload(row, 'hrcRunId') ?? refs.find((ref) => ref.startsWith('hrc'))
    return `hrc_run.mapped${hrcRun !== undefined ? ` ${hrcRun}` : ''}`
  }
  return `${row.type}${refs[0] !== undefined ? ` ${refs[0]}` : ''}`
}

function notesText(row: AcpTimelineRow, plain: boolean): string {
  if (row.rejectionCode !== undefined) return row.rejectionCode
  if (row.versionDelta !== undefined) {
    const arrow = plain ? '->' : '→'
    return `v${row.versionDelta.from}${arrow}v${row.versionDelta.to}`
  }
  if (row.scopeRef !== undefined) return `scope: ${row.scopeRef}`
  return ''
}

function renderHeader(
  projection: TaskTimelineProjection,
  options: Pick<ResolvedTimelineRenderOptions, 'plain' | 'color' | 'width'>
): string[] {
  const task = projection.task
  const status = task.state.status
  const phase = task.state.phase ?? 'none'
  const outcome = task.state.outcome ?? 'none'
  const span = spanOf(projection.summary.firstEventAt, projection.summary.lastEventAt)
  const lines = [
    `Task ${task.taskId}`,
    `Workflow: ${task.workflow.id}@${task.workflow.version}`,
    `Status: ${status}  Phase: ${phase}  Outcome: ${outcome}`,
    `Roles: ${roleLine(projection)}`,
    `Span: ${span}  ·  ${projection.summary.eventCount} events  ·  ${projection.summary.rejectionCount} rejections`,
    ...(projection.warnings ?? []).map(
      (warning) => `${options.plain ? 'WARNING' : '⚠'} ${warning}`
    ),
  ]

  if (options.plain) return lines

  const innerWidth = Math.max(20, options.width - 4)
  const title = lines[0] ?? 'Task'
  const top = `┌─ ${truncate(title, innerWidth - 3)} ${'─'.repeat(Math.max(0, innerWidth - title.length - 2))}┐`
  const body = lines.slice(1).map((line) => `│ ${pad(line, innerWidth)} │`)
  const bottom = `└${'─'.repeat(innerWidth + 2)}┘`
  return [
    maybeColor(options.color, chalk.gray, top),
    ...body.map((line) => maybeColor(options.color, chalk.gray, line)),
    maybeColor(options.color, chalk.gray, bottom),
  ]
}

function hrcKindCounts(summary: HrcTimelineRow['summary']): string {
  if (summary === undefined) return ''
  return Object.entries(summary.kindCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 5)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ')
}

function hrcText(row: HrcTimelineRow): string {
  if (row.marker === 'no_mapping') return 'hrc: no mapping'
  if (row.marker === 'no_events') return 'hrc: no events'
  if (row.marker === 'elided') return row.label ?? 'hrc events elided'
  if (row.summary !== undefined) {
    const counts = hrcKindCounts(row.summary)
    const range =
      row.summary.firstHrcSeq !== undefined && row.summary.lastHrcSeq !== undefined
        ? ` range hrc/${row.summary.firstHrcSeq}..${row.summary.lastHrcSeq}`
        : ''
    const joinLabel =
      row.joinKind === 'scope_window'
        ? ' (scope+window join)'
        : row.joinKind === 'event_window'
          ? ' (event-window join)'
          : ''
    return `hrc${joinLabel}: ${row.summary.totalCount} events${counts.length > 0 ? ` (${counts})` : ''}${range}`
  }
  const seq = row.hrcSeq !== undefined ? `hrc/${row.hrcSeq}` : 'hrc'
  if (row.displayText !== undefined) {
    return `${seq}  ${timeOf(row.ts)}  ${row.displayText}`
  }
  const label = row.label !== undefined ? `  ${row.label}` : ''
  return `${seq}  ${timeOf(row.ts)}  ${row.eventKind}${label}`
}

function renderHrcLine(
  row: HrcTimelineRow,
  options: Omit<ResolvedTimelineRenderOptions, 'markdown'> & { last: boolean }
): string {
  const text = hrcText(row)
  if (options.plain) return `      ${text}`
  const branch = options.last ? '└─' : '├─'
  const coloredBranch = maybeColor(options.color, chalk.gray, branch)
  const coloredText = row.marker === 'elided' ? maybeColor(options.color, chalk.gray, text) : text
  return `     ${coloredBranch} ${coloredText}`
}

function renderHrcCollapseLine(
  collapsed: { count: number; toolName: string },
  options: Omit<ResolvedTimelineRenderOptions, 'markdown'> & { last: boolean }
): string {
  const text = `… ${collapsed.count} more ${collapsed.toolName} call${collapsed.count === 1 ? '' : 's'}`
  if (options.plain) return `      ${text}`
  const branch = options.last ? '└─' : '├─'
  return `     ${maybeColor(options.color, chalk.gray, branch)} ${maybeColor(options.color, chalk.gray, text)}`
}

function renderAssistantBodyLines(
  row: HrcTimelineRow,
  options: Omit<ResolvedTimelineRenderOptions, 'markdown'>
): string[] {
  if (row.assistantBody === undefined || options.hrcDetail === 'summary') return []
  const bodyLines = renderMarkdownBlock(row.assistantBody, {
    width: Math.max(20, options.width - 12),
    maxLines: options.hrcDetail === 'full' ? 120 : 40,
    style: options.plain ? 'plain' : 'tty',
  })
  if (options.plain) {
    return bodyLines.map((line) => `      > ${line}`)
  }
  return [
    `        ${maybeColor(options.color, chalk.gray, '┌─')}`,
    ...bodyLines.map((line) => `        ${maybeColor(options.color, chalk.gray, '│')} ${line}`),
    `        ${maybeColor(options.color, chalk.gray, '└─')}`,
  ]
}

function renderPlainLike(
  projection: TaskTimelineProjection,
  options: Omit<ResolvedTimelineRenderOptions, 'markdown'>
): string {
  const lines = [...renderHeader(projection, options), '']
  if (projection.rows.length === 0) {
    lines.push('(no events yet)')
    return lines.join('\n')
  }

  const eventWidth = Math.max(24, Math.min(54, options.width - 55))
  const collapseByStart = new Map((projection.collapsedRuns ?? []).map((run) => [run.start, run]))
  let index = 0
  while (index < projection.rows.length) {
    const row = projection.rows[index]
    if (row === undefined) {
      index += 1
      continue
    }
    const collapsed = options.hrcDetail === 'events' ? collapseByStart.get(index) : undefined
    if (collapsed !== undefined) {
      const next = projection.rows[collapsed.end + 1]
      lines.push(
        renderHrcCollapseLine(collapsed, {
          ...options,
          last:
            next?.ledger !== 'hrc' ||
            next.parentParticipantRunId !== collapsed.parentParticipantRunId,
        })
      )
      index = collapsed.end + 1
      continue
    }
    if (!isAcpRow(row)) {
      lines.push(
        renderHrcLine(row, {
          ...options,
          last: isLastHrcRow(projection.rows, index, row),
        })
      )
      lines.push(...renderAssistantBodyLines(row, options))
      if (row.payload !== undefined && options.hrcDetail === 'full') {
        const indent = options.plain ? '      ' : '          '
        lines.push(`${indent}payload: ${truncate(JSON.stringify(row.payload), options.width - 19)}`)
      }
      index += 1
      continue
    }

    const symbol = styledSymbol(row, options)
    const seq = String(row.seq).padStart(3, ' ')
    const event = rowEventText(row, options.plain)
    const actor = actorText(row)
    const notes = notesText(row, options.plain)
    const rowLine = options.plain
      ? `${symbol} ${seq} ${timeOf(row.ts)}  ${pad(event, eventWidth)}  ${pad(actor, 18)} ${notes}`
      : `  ${symbol} ${seq}  ${maybeColor(options.color, chalk.dim, timeOf(row.ts))}  ${pad(event, eventWidth)}  ${pad(actor, 20)}  ${notes}`
    lines.push(row.kind === 'rejected' ? maybeColor(options.color, chalk.red, rowLine) : rowLine)

    if (options.verbose) {
      lines.push(
        `      payload: ${truncate(JSON.stringify(row.payload ?? {}), options.width - 15)}`
      )
      if (row.eventHash !== undefined || row.prevHash !== undefined) {
        lines.push(
          `      hash   : ${row.eventHash ?? '—'}${row.prevHash !== undefined ? `  prev: ${row.prevHash}` : ''}`
        )
      }
    }
    index += 1
  }
  return lines.join('\n')
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function markdownSymbol(row: AcpTimelineRow): string {
  if (row.kind === 'rejected') return '❌'
  if (row.category === 'run') return '▶️'
  if (row.category === 'mapping' || row.category === 'effect') return '◆'
  if (row.category === 'obligation') return '◇'
  if (row.category === 'anomaly') return '⚠️'
  return '✅'
}

function renderMarkdown(
  projection: TaskTimelineProjection,
  options: Pick<ResolvedTimelineRenderOptions, 'plain'>
): string {
  const task = projection.task
  const warnings = projection.warnings ?? []
  const lines = [
    `## Task ${task.taskId} · ${task.workflow.id}@${task.workflow.version}`,
    '',
    `**Status:** ${task.state.status} · **Phase:** ${task.state.phase ?? 'none'} · **Outcome:** ${task.state.outcome ?? 'none'} · ${projection.summary.eventCount} events, ${projection.summary.rejectionCount} rejections`,
    ...(warnings.length > 0
      ? ['', ...warnings.map((warning) => `> ⚠ ${escapeMarkdown(warning)}`)]
      : []),
    '',
    '| seq | time | event | actor | notes |',
    '|---:|---|---|---|---|',
  ]
  for (const row of projection.rows) {
    if (row.ledger === 'hrc') {
      lines.push(`- ${escapeMarkdown(hrcText(row))}`)
      if (row.assistantBody !== undefined && (projection.hrcDetail ?? 'events') !== 'summary') {
        for (const bodyLine of renderMarkdownBlock(row.assistantBody, {
          width: 100,
          maxLines: (projection.hrcDetail ?? 'events') === 'full' ? 120 : 40,
          style: 'markdown',
        })) {
          lines.push(`> ${bodyLine}`)
        }
      }
      if (row.payload !== undefined && projection.hrcDetail === 'full') {
        lines.push(`  - payload: ${escapeMarkdown(truncate(JSON.stringify(row.payload), 160))}`)
      }
      continue
    }
    lines.push(
      `| ${row.seq} | ${timeOf(row.ts)} | ${markdownSymbol(row)} ${escapeMarkdown(rowEventText(row, options.plain))} | ${escapeMarkdown(actorText(row))} | ${escapeMarkdown(notesText(row, options.plain))} |`
    )
  }
  return lines.join('\n')
}

export function renderTimeline(
  projection: TaskTimelineProjection,
  options: TimelineRenderOptions = {}
): string {
  const resolved: ResolvedTimelineRenderOptions = {
    verbose: options.verbose ?? false,
    markdown: options.markdown ?? false,
    plain: options.plain ?? false,
    color: options.color ?? false,
    width: options.width ?? 100,
    hrcDetail: options.hrcDetail ?? projection.hrcDetail ?? 'events',
  }
  if (resolved.markdown) {
    return renderMarkdown(projection, { plain: resolved.plain })
  }
  return renderPlainLike(projection, resolved)
}
