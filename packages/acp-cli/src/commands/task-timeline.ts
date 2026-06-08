import { CliUsageError } from '../cli-runtime.js'
import { HrcStoreReader, resolveHrcStorePath } from '../hrc-store-reader.js'
import {
  type HrcAnchorMode,
  type HrcDetailMode,
  hasParticipantRunLaunch,
  joinHrcTimeline,
  resolvedAnchors,
} from '../output/timeline-hrc-join.js'
import {
  type TaskTimelineProjection,
  type TimelineCategory,
  projectTaskTimeline,
} from '../output/timeline-project.js'
import { renderTimeline } from '../output/timeline-render.js'
import {
  hasFlag,
  parseArgs,
  parseCommaList,
  parseIntegerValue,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  getClientFactory,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

const categories = new Set<TimelineCategory>([
  'transition',
  'evidence',
  'run',
  'mapping',
  'obligation',
  'effect',
  'anomaly',
  'meta',
])

const pluralCategoryAliases: Readonly<Record<string, TimelineCategory>> = {
  transitions: 'transition',
  evidence: 'evidence',
  runs: 'run',
  mappings: 'mapping',
  obligations: 'obligation',
  effects: 'effect',
  anomalies: 'anomaly',
  meta: 'meta',
}

function parseCategoryCsv(
  flag: string,
  raw: string | undefined
): { categories?: Set<TimelineCategory> | undefined; rejectionsOnly?: boolean | undefined } {
  if (raw === undefined) return {}
  const parsedCategories = new Set<TimelineCategory>()
  let rejectionsOnly = false
  for (const item of raw.split(',')) {
    const value = item.trim()
    if (value.length === 0) continue
    if (value === 'rejections' || value === 'rejected') {
      rejectionsOnly = true
      continue
    }
    const category = categories.has(value as TimelineCategory)
      ? (value as TimelineCategory)
      : pluralCategoryAliases[value]
    if (category === undefined) {
      throw new CliUsageError(`${flag} has unknown category: ${value}`)
    }
    parsedCategories.add(category)
  }
  if (parsedCategories.size === 0 && !rejectionsOnly) {
    throw new CliUsageError(`${flag} must include at least one category`)
  }
  if (parsedCategories.size > 0) {
    rejectionsOnly = false
  }
  return {
    ...(parsedCategories.size > 0 ? { categories: parsedCategories } : {}),
    ...(rejectionsOnly ? { rejectionsOnly } : {}),
  }
}

function parseTimeFilter(
  flag: string,
  raw: string | undefined,
  now = Date.now()
): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  const relative = /^(\d+)(m|h|d)$/.exec(trimmed)
  if (relative !== null) {
    const amount = Number.parseInt(relative[1] ?? '0', 10)
    const unit = relative[2]
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return now - amount * factor
  }
  const parsed = new Date(trimmed).getTime()
  if (Number.isNaN(parsed)) {
    throw new CliUsageError(
      `${flag} must be an ISO timestamp or relative duration like 5m, 1h, or 2d`
    )
  }
  return parsed
}

function filterProjection(
  projection: TaskTimelineProjection,
  options: {
    only?: Set<TimelineCategory> | undefined
    skip?: Set<TimelineCategory> | undefined
    rejectionsOnly?: boolean | undefined
    since?: number | undefined
    until?: number | undefined
  }
): TaskTimelineProjection {
  const rows = projection.rows.filter((row) => {
    if (row.ledger !== 'acp') return true
    if (options.only !== undefined && !options.only.has(row.category)) return false
    if (options.skip?.has(row.category)) return false
    if (options.rejectionsOnly === true && row.kind !== 'rejected') return false
    const ts = new Date(row.ts).getTime()
    if (options.since !== undefined && Number.isFinite(ts) && ts < options.since) return false
    if (options.until !== undefined && Number.isFinite(ts) && ts > options.until) return false
    return true
  })
  return {
    task: projection.task,
    summary: {
      eventCount: rows.length,
      rejectionCount: rows.filter((row) => row.ledger === 'acp' && row.kind === 'rejected').length,
      ...(rows[0]?.ts !== undefined ? { firstEventAt: rows[0].ts } : {}),
      ...(rows.at(-1)?.ts !== undefined ? { lastEventAt: rows.at(-1)?.ts } : {}),
    },
    rows,
    ...(projection.warnings !== undefined ? { warnings: projection.warnings } : {}),
  }
}

function parseHrcDetail(raw: string | undefined): HrcDetailMode {
  if (raw === undefined) return 'events'
  if (raw === 'summary' || raw === 'events' || raw === 'full') return raw
  throw new CliUsageError('--hrc-detail must be one of: summary, events, full')
}

function parseHrcAnchor(raw: string | undefined): HrcAnchorMode {
  if (raw === undefined) return 'auto'
  if (raw === 'runs' || raw === 'events' || raw === 'both' || raw === 'auto') return raw
  throw new CliUsageError('--hrc-anchor must be one of: runs, events, both, auto')
}

function parseHrcKinds(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined
  return new Set(parseCommaList(raw, '--hrc-kinds'))
}

function withTimelineWarning(
  projection: TaskTimelineProjection,
  warning: string
): TaskTimelineProjection {
  return {
    ...projection,
    warnings: [...(projection.warnings ?? []), warning],
  }
}

function hasExternalRunBindings(response: {
  runs?: Array<{ externalRunRef?: string | undefined }>
}): boolean {
  return (response.runs ?? []).some(
    (run) => run.externalRunRef !== undefined && run.externalRunRef.length > 0
  )
}

export async function runTaskTimelineCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: [
      '--json',
      '--verbose',
      '-v',
      '--rejections-only',
      '--markdown',
      '--plain',
      '--no-color',
      '--no-hrc',
      '--hrc-all-kinds',
    ],
    stringFlags: [
      '--task',
      '--server',
      '--actor',
      '--only',
      '--skip',
      '--since',
      '--until',
      '--width',
      '--hrc-detail',
      '--hrc-kinds',
      '--hrc-store',
      '--hrc-anchor',
      '--hrc-event-window',
    ],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const client = getClientFactory(deps)({
    serverUrl,
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
  })

  const response = await client.getTask({ taskId: requireStringFlag(parsed, '--task') })
  const projected = projectTaskTimeline(response)
  const only = parseCategoryCsv('--only', readStringFlag(parsed, '--only'))
  const skip = parseCategoryCsv('--skip', readStringFlag(parsed, '--skip'))
  const since = parseTimeFilter('--since', readStringFlag(parsed, '--since'))
  const until = parseTimeFilter('--until', readStringFlag(parsed, '--until'))
  let filtered = filterProjection(projected, {
    ...(only.categories !== undefined ? { only: only.categories } : {}),
    ...(skip.categories !== undefined ? { skip: skip.categories } : {}),
    ...(hasFlag(parsed, '--rejections-only') || only.rejectionsOnly === true
      ? { rejectionsOnly: true }
      : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  })

  if (!hasFlag(parsed, '--no-hrc')) {
    const hrcAnchor = parseHrcAnchor(readStringFlag(parsed, '--hrc-anchor'))
    const anchors = resolvedAnchors(filtered.rows, hrcAnchor)
    const hrcEventWindow =
      readStringFlag(parsed, '--hrc-event-window') !== undefined
        ? parseIntegerValue('--hrc-event-window', requireStringFlag(parsed, '--hrc-event-window'), {
            min: 1,
          })
        : 30
    if (
      anchors.runs &&
      !anchors.events &&
      hasParticipantRunLaunch(filtered.rows) &&
      !hasExternalRunBindings(response)
    ) {
      filtered = withTimelineWarning(
        filtered,
        'No HRC-bound wrkf runs for this task; rendering ACP-only.'
      )
    } else if (anchors.runs || anchors.events) {
      const hrcStorePath = resolveHrcStorePath(readStringFlag(parsed, '--hrc-store'), env)
      const hrcDetail = parseHrcDetail(readStringFlag(parsed, '--hrc-detail'))
      const hrcKinds = parseHrcKinds(readStringFlag(parsed, '--hrc-kinds'))
      let reader: HrcStoreReader | undefined
      try {
        reader = new HrcStoreReader(hrcStorePath)
        filtered = joinHrcTimeline(filtered, {
          reader,
          response,
          detail: hrcDetail,
          anchorMode: hrcAnchor,
          eventWindowSeconds: hrcEventWindow,
          ...(hrcKinds !== undefined ? { kinds: hrcKinds } : {}),
          ...(hasFlag(parsed, '--hrc-all-kinds') ? { allKinds: true } : {}),
        })
      } catch {
        filtered = withTimelineWarning(
          filtered,
          `HRC store at ${hrcStorePath} is unreachable; rendering ACP-only.`
        )
      } finally {
        reader?.close()
      }
    }
  }

  if (hasFlag(parsed, '--json')) {
    return asJson(filtered)
  }

  const width =
    readStringFlag(parsed, '--width') !== undefined
      ? parseIntegerValue('--width', requireStringFlag(parsed, '--width'), { min: 40 })
      : (process.stdout.columns ?? 100)
  const plain = hasFlag(parsed, '--plain')
  const color =
    !plain &&
    !hasFlag(parsed, '--no-color') &&
    env['NO_COLOR'] === undefined &&
    process.stdout.isTTY === true

  return asText(
    renderTimeline(filtered, {
      verbose: hasFlag(parsed, '--verbose') || hasFlag(parsed, '-v'),
      markdown: hasFlag(parsed, '--markdown'),
      plain,
      color,
      width,
    })
  )
}
