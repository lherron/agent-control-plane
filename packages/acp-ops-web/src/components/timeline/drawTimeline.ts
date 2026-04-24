import type { DashboardEvent, DashboardEventFamily, SessionTimelineRow } from 'acp-ops-projection'
import { FAMILY_COLORS, colorForRole } from '../../lib/colors'
import { compactRef, parseScopeRef, rowKey } from '../../lib/sessionRefs'
import { ageLabel, clockLabel } from '../../lib/time'

export type TimelineMode = 'overview' | 'detail'

export type TimelineLayout = {
  width: number
  height: number
  timelineLeft: number
  timelineWidth: number
  windowFromMs: number
  windowToMs: number
  pxPerMs: number
}

export type BeadHit = {
  event: DashboardEvent
  x: number
  y: number
}

export type TimelineMeta = {
  branchCount: number
  rejoinCount: number
  warningCount: number
  nowX: number
}

export type DrawTimelineInput = {
  ctx: CanvasRenderingContext2D
  layout: TimelineLayout
  rows: SessionTimelineRow[]
  events: DashboardEvent[]
  mode: TimelineMode
  selectedEventId?: string | undefined
  paused: boolean
  reducedMotion: boolean
  gapFromSeq?: number | undefined
  frozenNowX?: number | undefined
}

export const TIME_AXIS_HEIGHT = 48
export const ROW_TOP = 76
export const ROW_HEIGHT = 172
export const HIT_WIDTH = 24
export const HIT_HEIGHT = 20
export const DEFAULT_WINDOW_MS = 90_000
export const LANE_LABEL_WIDTH = 110
export const FAMILY_LANES: DashboardEventFamily[] = [
  'runtime',
  'agent_message',
  'tool',
  'input',
  'delivery',
  'handoff',
]

const HISTOGRAM_HEIGHT = 22
const BEAD_RADIUS = 4
const TIMELINE_LEFT_RATIO = 0.29
const TIMELINE_WIDTH_RATIO = 0.67
const ROW_INSET_TOP = 16
const ROW_INSET_BOTTOM = 18
const LANE_GAP = 21
const FALLBACK_FAMILY_COLOR = 'rgb(0, 216, 255)'

export function computeTimelineLayout(
  width: number,
  height: number,
  fromTs: string,
  toTs: string
): TimelineLayout {
  const fallbackToMs = Date.now()
  const parsedFrom = Date.parse(fromTs)
  const parsedTo = Date.parse(toTs)
  const windowToMs = Number.isFinite(parsedTo) ? parsedTo : fallbackToMs
  const windowFromMs = Number.isFinite(parsedFrom) ? parsedFrom : windowToMs - DEFAULT_WINDOW_MS
  const timelineLeft = TIMELINE_LEFT_RATIO * width
  const timelineWidth = TIMELINE_WIDTH_RATIO * width

  return {
    width,
    height,
    timelineLeft,
    timelineWidth,
    windowFromMs,
    windowToMs,
    pxPerMs: timelineWidth / Math.max(1, windowToMs - windowFromMs),
  }
}

export function timelineWindowForEvents(
  events: DashboardEvent[],
  fallbackFromTs: string,
  fallbackToTs: string
): { fromTs: string; toTs: string } {
  const eventTimes = events
    .map((event) => Date.parse(event.ts))
    .filter((time) => Number.isFinite(time))

  if (eventTimes.length === 0) return { fromTs: fallbackFromTs, toTs: fallbackToTs }

  const earliest = Math.min(...eventTimes)
  const latest = Math.max(...eventTimes)
  const span = latest - earliest
  const minimumWindowMs = 30_000
  const paddingMs = Math.max(5_000, Math.min(30_000, span * 0.08))
  const fromMs = span < minimumWindowMs ? latest - minimumWindowMs : earliest - paddingMs
  const toMs = Math.max(latest + paddingMs, fromMs + 1_000)

  return {
    fromTs: new Date(fromMs).toISOString(),
    toTs: new Date(toMs).toISOString(),
  }
}

export function hitTest(x: number, y: number, beads: BeadHit[]): DashboardEvent | null {
  let selected: BeadHit | null = null
  let selectedDistance = Number.POSITIVE_INFINITY
  for (const bead of beads) {
    const dx = Math.abs(x - bead.x)
    const dy = Math.abs(y - bead.y)
    if (dx > HIT_WIDTH / 2 || dy > HIT_HEIGHT / 2) continue
    const distance = dx * dx + dy * dy
    if (distance < selectedDistance) {
      selected = bead
      selectedDistance = distance
    }
  }
  return selected?.event ?? null
}

export function drawTimeline(input: DrawTimelineInput): { beads: BeadHit[]; meta: TimelineMeta } {
  const {
    ctx,
    layout,
    rows,
    events,
    mode,
    selectedEventId,
    paused,
    reducedMotion,
    gapFromSeq,
    frozenNowX,
  } = input
  const rowIndex = new Map(rows.map((row, index) => [rowKey(row), index]))
  const beads: BeadHit[] = []
  let branchCount = 0
  let rejoinCount = 0
  let warningCount = 0

  ctx.clearRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = '#061016'
  ctx.fillRect(0, 0, layout.width, layout.height)

  drawGrid(ctx, layout, events)

  for (let index = 0; index < Math.max(1, rows.length); index += 1) {
    drawRow(ctx, layout, rows[index], index, mode)
  }

  if (mode === 'detail' && rows.length > 0 && events.length === 0) {
    drawEmptyDetail(ctx, layout)
  }

  const eventsByRow = new Map<string, DashboardEvent[]>()
  for (const event of events) {
    const key = `${event.hostSessionId}:${event.generation}`
    const rowEvents = eventsByRow.get(key) ?? []
    rowEvents.push(event)
    eventsByRow.set(key, rowEvents)
  }

  for (const [key, rowEvents] of eventsByRow) {
    const index = rowIndex.get(key)
    if (index === undefined) continue
    let localPreviousX = layout.timelineLeft

    const branchStarts = rowEvents.filter(isBranchStart)
    const branchEnds = rowEvents.filter(isBranchEnd)
    for (const start of branchStarts) {
      const end = branchEnds.find((candidate) => candidate.hrcSeq > start.hrcSeq)
      const startX = eventToX(start, layout, localPreviousX)
      const endX = end ? eventToX(end, layout, startX) : Math.min(layout.width - 16, startX + 34)
      branchCount += 1
      if (end) rejoinCount += 1
      drawBranch(ctx, layout, index, startX, endX, reducedMotion)
    }

    for (const event of rowEvents) {
      const x = eventToX(event, layout, localPreviousX)
      localPreviousX = x
      const eventY = laneY(index, FAMILY_LANES.includes(event.family) ? event.family : 'runtime')
      if (
        event.family === 'warning' ||
        event.severity === 'warning' ||
        event.severity === 'error'
      ) {
        warningCount += 1
      }
      drawBead(ctx, x, eventY, event, event.id === selectedEventId, reducedMotion)
      beads.push({ event, x, y: eventY })
    }
  }

  if (gapFromSeq !== undefined) drawGap(ctx, layout, gapFromSeq)

  const nowX =
    paused && frozenNowX !== undefined
      ? frozenNowX
      : layout.timelineLeft + LANE_LABEL_WIDTH + layout.timelineWidth - LANE_LABEL_WIDTH
  drawNow(ctx, layout, nowX)

  return { beads, meta: { branchCount, rejoinCount, warningCount, nowX: Math.round(nowX) } }
}

function drawGrid(ctx: CanvasRenderingContext2D, layout: TimelineLayout, events: DashboardEvent[]) {
  const trackStart = layout.timelineLeft + LANE_LABEL_WIDTH
  ctx.strokeStyle = 'rgba(97, 146, 172, 0.14)'
  ctx.lineWidth = 1
  for (let tick = 0; tick <= 12; tick += 1) {
    const x = trackStart + ((layout.timelineWidth - LANE_LABEL_WIDTH) / 12) * tick
    ctx.beginPath()
    ctx.moveTo(x, TIME_AXIS_HEIGHT)
    ctx.lineTo(x, layout.height)
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(181, 209, 227, 0.66)'
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  for (let tick = 0; tick <= 3; tick += 1) {
    const ms = layout.windowFromMs + ((layout.windowToMs - layout.windowFromMs) / 3) * tick
    const x = trackStart + ((layout.timelineWidth - LANE_LABEL_WIDTH) / 3) * tick
    ctx.fillText(clockLabel(new Date(ms).toISOString()), x, 24)
  }

  const bins = new Array<number>(24).fill(0)
  let previousX = layout.timelineLeft
  for (const event of events) {
    const x = eventToX(event, layout, previousX)
    previousX = x
    const index = Math.min(
      bins.length - 1,
      Math.max(0, Math.floor(((x - layout.timelineLeft) / layout.timelineWidth) * bins.length))
    )
    bins[index] = (bins[index] ?? 0) + 1
  }
  const maxBin = Math.max(1, ...bins)
  const binWidth = (layout.timelineWidth - LANE_LABEL_WIDTH) / bins.length
  ctx.fillStyle = 'rgba(0, 216, 255, 0.26)'
  for (let index = 0; index < bins.length; index += 1) {
    const height = ((bins[index] ?? 0) / maxBin) * (HISTOGRAM_HEIGHT - 4)
    ctx.fillRect(
      trackStart + index * binWidth,
      TIME_AXIS_HEIGHT + HISTOGRAM_HEIGHT - height,
      binWidth - 1,
      height
    )
  }
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  layout: TimelineLayout,
  row: SessionTimelineRow | undefined,
  index: number,
  mode: TimelineMode
) {
  const y = ROW_TOP + index * ROW_HEIGHT
  const metadataWidth = Math.max(150, layout.timelineLeft - 18)
  const trackStart = layout.timelineLeft + LANE_LABEL_WIDTH

  ctx.fillStyle = index % 2 === 0 ? 'rgba(3, 28, 30, 0.78)' : 'rgba(14, 30, 18, 0.72)'
  ctx.fillRect(0, y, layout.width, ROW_HEIGHT - 8)
  ctx.strokeStyle = index === 0 ? 'rgba(0, 219, 255, 0.85)' : 'rgba(89, 224, 70, 0.34)'
  ctx.lineWidth = index === 0 ? 1.5 : 1
  ctx.strokeRect(1, y + 1, layout.width - 3, ROW_HEIGHT - 10)

  ctx.strokeStyle = 'rgba(77, 122, 146, 0.22)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(metadataWidth, y + 1)
  ctx.lineTo(metadataWidth, y + ROW_HEIGHT - 10)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(layout.timelineLeft + LANE_LABEL_WIDTH - 12, y + 1)
  ctx.lineTo(layout.timelineLeft + LANE_LABEL_WIDTH - 12, y + ROW_HEIGHT - 10)
  ctx.stroke()

  if (!row) return

  const metadataX = 16
  const metadataRight = metadataWidth - 12
  const metadataInnerWidth = Math.max(120, metadataRight - metadataX)
  const scope = parseScopeRef(row.sessionRef.scopeRef)
  const workLabel = scope.role && !scope.task ? 'role' : 'task'
  const workValue = scope.task ?? scope.role ?? 'n/a'

  ctx.textAlign = 'left'
  ctx.fillStyle = colorForRole(row.visualState.colorRole)
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(
    mode === 'detail'
      ? `${index === 0 ? 'CURRENT' : 'PREVIOUS'} · GEN ${row.generation}`
      : (row.runtime?.status ?? 'unknown').toUpperCase(),
    metadataX,
    y + 28
  )

  if (scope.fallback) {
    drawTruncatedText(
      ctx,
      scope.fallback,
      metadataX,
      y + 50,
      metadataInnerWidth,
      '12px ui-monospace, SFMono-Regular, Menlo, monospace',
      'rgba(239, 249, 255, 0.9)'
    )
  } else {
    const laneWidth = Math.min(76, Math.max(56, metadataInnerWidth * 0.28))
    const firstRowWidth = Math.max(54, metadataInnerWidth - laneWidth - 6)
    drawScopePill(ctx, metadataX, y + 41, firstRowWidth, '#00d8ff', 'agent', scope.agent ?? 'n/a')
    drawScopePill(
      ctx,
      metadataX + firstRowWidth + 6,
      y + 41,
      laneWidth,
      '#59ff46',
      'lane',
      row.sessionRef.laneRef
    )
    drawScopePill(
      ctx,
      metadataX,
      y + 68,
      metadataInnerWidth,
      '#3b82f6',
      'project',
      scope.project ?? 'n/a'
    )
    drawScopePill(ctx, metadataX, y + 95, metadataInnerWidth, '#f1b83b', workLabel, workValue)
  }

  ctx.fillStyle = 'rgba(161, 189, 207, 0.72)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  const details: Array<[string, string]> = [
    ['host', row.hostSessionId.slice(0, 8)],
    ['runtime', row.runtime?.runtimeId ?? 'n/a'],
  ]
  const detailStartY = scope.fallback ? y + 76 : y + 130
  for (const [detailIndex, [label, value]] of details.entries()) {
    const detailY = detailStartY + detailIndex * 12
    ctx.fillStyle = 'rgba(108, 151, 176, 0.82)'
    ctx.fillText(label, metadataX, detailY)
    ctx.fillStyle =
      value === 'running' || value === 'true'
        ? 'rgba(91, 255, 106, 0.95)'
        : 'rgba(211, 232, 244, 0.72)'
    drawTruncatedText(
      ctx,
      compactRef(value, 28),
      metadataX + 62,
      detailY,
      Math.max(40, metadataInnerWidth - 62),
      '10px ui-monospace, SFMono-Regular, Menlo, monospace',
      ctx.fillStyle.toString()
    )
  }
  drawTruncatedText(
    ctx,
    `${ageLabel(row.stats.lastEventAt)}  ${row.hostSessionId.slice(-8)}  gen ${row.generation}`,
    metadataX,
    y + ROW_HEIGHT - 22,
    metadataInnerWidth,
    '10px ui-monospace, SFMono-Regular, Menlo, monospace',
    'rgba(161, 189, 207, 0.72)'
  )

  for (const family of FAMILY_LANES) {
    const familyY = laneY(index, family)
    const color = FAMILY_COLORS[family] ?? FALLBACK_FAMILY_COLOR
    ctx.fillStyle = color
    ctx.globalAlpha = 0.9
    ctx.fillRect(layout.timelineLeft + 8, familyY - 8, 16, 16)
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(family.replace('_', ' ').toUpperCase(), layout.timelineLeft + 32, familyY + 4)
    ctx.strokeStyle = color.replace('rgb', 'rgba').replace(')', ', 0.28)')
    ctx.beginPath()
    ctx.moveTo(trackStart, familyY)
    ctx.lineTo(layout.width - 8, familyY)
    ctx.stroke()
  }
}

function drawEmptyDetail(ctx: CanvasRenderingContext2D, layout: TimelineLayout) {
  const trackStart = layout.timelineLeft + LANE_LABEL_WIDTH
  const y = ROW_TOP + 92
  ctx.fillStyle = 'rgba(181, 209, 227, 0.72)'
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'left'
  ctx.fillText('No events in the loaded detail window yet.', trackStart, y)
  ctx.fillStyle = 'rgba(126, 152, 168, 0.82)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(
    'Backfill is requested when a selected card is outside the live event window.',
    trackStart,
    y + 18
  )
}

function drawBranch(
  ctx: CanvasRenderingContext2D,
  _layout: TimelineLayout,
  rowIndex: number,
  startX: number,
  endX: number,
  reducedMotion: boolean
) {
  const branchY = laneY(rowIndex, 'input')
  ctx.save()
  ctx.strokeStyle = FAMILY_COLORS['input'] ?? FALLBACK_FAMILY_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash(reducedMotion ? [4, 4] : [7, 4])
  ctx.beginPath()
  ctx.moveTo(startX, branchY)
  ctx.lineTo(startX, branchY - 18)
  ctx.lineTo(endX, branchY - 18)
  ctx.lineTo(endX, branchY)
  ctx.stroke()
  ctx.restore()
}

function drawBead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  event: DashboardEvent,
  selected: boolean,
  reducedMotion: boolean
) {
  const color = FAMILY_COLORS[event.family] ?? FAMILY_COLORS['runtime'] ?? FALLBACK_FAMILY_COLOR
  ctx.fillStyle = color
  ctx.strokeStyle = selected
    ? '#ffffff'
    : event.severity === 'warning' || event.severity === 'error'
      ? 'rgba(255,255,255,0.75)'
      : 'rgba(255,255,255,0.28)'
  ctx.lineWidth = selected ? 3 : 1.25
  ctx.beginPath()

  if (event.severity === 'warning') {
    ctx.moveTo(x, y - BEAD_RADIUS)
    ctx.lineTo(x + BEAD_RADIUS, y + BEAD_RADIUS)
    ctx.lineTo(x - BEAD_RADIUS, y + BEAD_RADIUS)
    ctx.closePath()
  } else if (event.severity === 'error') {
    ctx.rect(x - BEAD_RADIUS, y - BEAD_RADIUS, BEAD_RADIUS * 2, BEAD_RADIUS * 2)
  } else if (event.severity === 'success') {
    ctx.moveTo(x, y - BEAD_RADIUS)
    ctx.lineTo(x + BEAD_RADIUS, y)
    ctx.lineTo(x, y + BEAD_RADIUS)
    ctx.lineTo(x - BEAD_RADIUS, y)
    ctx.closePath()
  } else {
    ctx.arc(x, y, BEAD_RADIUS, 0, Math.PI * 2)
  }

  ctx.fill()
  ctx.stroke()

  if (selected && !reducedMotion) {
    ctx.globalAlpha = 0.22
    ctx.beginPath()
    ctx.arc(x, y, BEAD_RADIUS + 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

function drawGap(ctx: CanvasRenderingContext2D, layout: TimelineLayout, gapFromSeq: number) {
  ctx.fillStyle = 'rgba(248,113,113,0.16)'
  ctx.fillRect(layout.timelineLeft - 6, TIME_AXIS_HEIGHT, 12, layout.height - TIME_AXIS_HEIGHT)
  ctx.fillStyle = FAMILY_COLORS['warning'] ?? 'rgb(248, 113, 113)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`gap from ${gapFromSeq}`, layout.timelineLeft + 8, TIME_AXIS_HEIGHT + 14)
}

function drawNow(ctx: CanvasRenderingContext2D, layout: TimelineLayout, nowX: number) {
  ctx.strokeStyle = 'rgba(0, 220, 255, 0.95)'
  ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(0, 220, 255, 0.9)'
  ctx.shadowBlur = 12
  ctx.beginPath()
  ctx.moveTo(nowX, TIME_AXIS_HEIGHT)
  ctx.lineTo(nowX, layout.height)
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(0, 220, 255, 0.95)'
  ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.fillText('LIVE', nowX, TIME_AXIS_HEIGHT - 4)
}

export function eventToX(event: DashboardEvent, layout: TimelineLayout, previousX: number): number {
  const eventMs = Date.parse(event.ts)
  if (!Number.isFinite(eventMs)) return previousX + BEAD_RADIUS * 2
  return (
    layout.timelineLeft +
    LANE_LABEL_WIDTH +
    (eventMs - layout.windowFromMs) *
      ((layout.timelineWidth - LANE_LABEL_WIDTH) /
        Math.max(1, layout.windowToMs - layout.windowFromMs))
  )
}

export function laneY(rowIndex: number, family: DashboardEventFamily): number {
  const familyIndex = Math.max(0, FAMILY_LANES.indexOf(family))
  const laneSpan = (FAMILY_LANES.length - 1) * LANE_GAP
  const rowInnerHeight = ROW_HEIGHT - ROW_INSET_TOP - ROW_INSET_BOTTOM
  const firstLaneY =
    ROW_TOP + rowIndex * ROW_HEIGHT + ROW_INSET_TOP + (rowInnerHeight - laneSpan) / 2
  return firstLaneY + familyIndex * LANE_GAP
}

function drawScopePill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  color: string,
  label: string,
  value: string
) {
  const height = 20
  ctx.save()
  ctx.fillStyle = 'rgba(3, 15, 22, 0.72)'
  ctx.strokeStyle = colorToAlpha(color, 0.52)
  ctx.lineWidth = 1
  roundedRect(ctx, x, y, width, height, 5)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = colorToAlpha(color, 0.18)
  ctx.fillRect(x + 1, y + 1, 3, height - 2)

  drawTruncatedText(
    ctx,
    label === 'lane' ? value : compactRef(value, 24),
    x + 9,
    y + 14,
    width - 16,
    'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace',
    'rgba(239, 249, 255, 0.92)'
  )
  ctx.restore()
}

function drawTruncatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: string,
  color: string
) {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y)
    return
  }

  const ellipsis = '...'
  let end = text.length
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}${ellipsis}`).width > maxWidth) {
    end -= 1
  }
  ctx.fillText(`${text.slice(0, Math.max(0, end))}${ellipsis}`, x, y)
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function colorToAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const red = Number.parseInt(color.slice(1, 3), 16)
    const green = Number.parseInt(color.slice(3, 5), 16)
    const blue = Number.parseInt(color.slice(5, 7), 16)
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }
  return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`)
}

function isBranchStart(event: DashboardEvent): boolean {
  return event.eventKind === 'user_input_received' || event.eventKind === 'inflight.accepted'
}

function isBranchEnd(event: DashboardEvent): boolean {
  return (
    event.eventKind === 'user_input_applied_in_flight' || event.eventKind === 'inflight.applied'
  )
}
