import { hasFlag, parseArgs, requireNoPositionals } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'

import {
  readSessionRefFlags,
  requireSessionRefFlags,
  resolveConcreteSessionId,
} from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asText,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type SessionSummary = {
  sessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  status: string
  createdAt: string
  updatedAt: string
}

type SessionListResponse = {
  sessions: SessionSummary[]
}

type SessionShowResponse = {
  session: SessionSummary
}

type SessionRunsResponse = {
  runs: Array<Record<string, unknown>>
}

type SessionResetResponse = {
  sessionId: string
  generation: number
  priorSessionId?: string | undefined
}

type SessionInterruptResponse = {
  ok: boolean
  runtimeId: string
}

type SessionCaptureResponse = {
  text: string
}

type AttachCommandResponse = {
  transport: string
  argv: string[]
  bindingFence?: Record<string, unknown> | undefined
}

function renderSessionsTable(response: SessionListResponse): string {
  return renderTable(
    [
      { header: 'Session', value: (row: SessionSummary) => row.sessionId },
      { header: 'Scope', value: (row: SessionSummary) => row.scopeRef },
      { header: 'Lane', value: (row: SessionSummary) => row.laneRef },
      { header: 'Status', value: (row: SessionSummary) => row.status },
      { header: 'Gen', value: (row: SessionSummary) => String(row.generation) },
    ],
    response.sessions
  )
}

function renderRunsTable(response: SessionRunsResponse): string {
  return renderTable(
    [
      { header: 'Run', value: (row: Record<string, unknown>) => String(row['runId'] ?? '') },
      { header: 'Status', value: (row: Record<string, unknown>) => String(row['status'] ?? '') },
      { header: 'Scope', value: (row: Record<string, unknown>) => String(row['scopeRef'] ?? '') },
      { header: 'Lane', value: (row: Record<string, unknown>) => String(row['laneRef'] ?? '') },
    ],
    response.runs
  )
}

function shellEscape(argument: string): string {
  return /^[A-Za-z0-9_./:@%-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`
}

export async function runSessionCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--session', '--scope-ref', '--lane-ref', '--server', '--actor', '--project'],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('session help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'resolve') {
    const response = await requester.requestJson<{ sessionId: string }>({
      method: 'POST',
      path: '/v1/sessions/resolve',
      body: { sessionRef: requireSessionRefFlags(parsed) },
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response))
  }

  if (subcommand === 'list') {
    const filters = readSessionRefFlags(parsed)
    const query = new URLSearchParams()
    if (filters?.scopeRef !== undefined) {
      query.set('scopeRef', filters.scopeRef)
    }
    if (filters?.laneRef !== undefined) {
      query.set('laneRef', filters.laneRef)
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await requester.requestJson<SessionListResponse>({
      method: 'GET',
      path: `/v1/sessions${suffix}`,
    })
    return renderJsonOrTable(parsed, response, () => renderSessionsTable(response))
  }

  if (subcommand === 'show') {
    const sessionId = await resolveConcreteSessionId(parsed, deps)
    const response = await requester.requestJson<SessionShowResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.session))
  }

  if (subcommand === 'runs') {
    const sessionId = await resolveConcreteSessionId(parsed, deps)
    const response = await requester.requestJson<SessionRunsResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
    })
    return renderJsonOrTable(parsed, response, () => renderRunsTable(response))
  }

  if (subcommand === 'reset') {
    const response = await requester.requestJson<SessionResetResponse>({
      method: 'POST',
      path: '/v1/sessions/reset',
      body: { sessionRef: requireSessionRefFlags(parsed) },
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response))
  }

  if (subcommand === 'interrupt') {
    const sessionId = await resolveConcreteSessionId(parsed, deps)
    const response = await requester.requestJson<SessionInterruptResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response))
  }

  if (subcommand === 'capture') {
    const sessionId = await resolveConcreteSessionId(parsed, deps)
    const response = await requester.requestJson<SessionCaptureResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/capture`,
    })
    if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
      return asText(response.text)
    }
    return renderJsonOrTable(parsed, response, () => response.text)
  }

  if (subcommand === 'attach-command') {
    const sessionId = await resolveConcreteSessionId(parsed, deps)
    const response = await requester.requestJson<AttachCommandResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/attach-command`,
    })

    return renderJsonOrTable(parsed, response, () => {
      const command = response.argv.map((part) => shellEscape(part)).join(' ')
      return [command, '', renderKeyValueTable(response.bindingFence ?? {})].join('\n').trim()
    })
  }

  throw new CliUsageError(`unknown session subcommand: ${subcommand}`)
}
