import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  readStringFlag,
  requireNoPositionals,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError, AcpClientTransportError } from '../http-client.js'
import { type TailEvent, parseNdjsonText, streamNdjsonEvents } from '../output/replay-reducer.js'
import { renderTable } from '../output/table.js'

import { resolveConcreteSessionId } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asText,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

/**
 * Live tail of /sessions/{sessionId}/events.
 *
 * In streaming mode (default) records are printed incrementally as they
 * arrive from the NDJSON stream — the CLI does NOT buffer the full
 * response before printing.
 *
 * When `--json` or `--table` is passed the command still collects all
 * events (since structured output requires the complete set) but the
 * fetch itself streams through the body reader so memory stays bounded
 * for large replays.
 */
export async function runTailCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--table'],
    stringFlags: [
      '--session',
      '--scope-ref',
      '--lane-ref',
      '--from-seq',
      '--server',
      '--actor',
      '--project',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('tail help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const sessionId = await resolveConcreteSessionId(parsed, deps)
  const query = new URLSearchParams()
  if (parsed.stringFlags['--from-seq'] !== undefined) {
    query.set(
      'fromSeq',
      String(parseIntegerValue('--from-seq', parsed.stringFlags['--from-seq'], { min: 0 }))
    )
  }

  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env).replace(/\/+$/, '')
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const fetchImpl = deps.fetchImpl ?? fetch

  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const url = `${serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`

  const headers = new Headers()
  if (actorAgentId !== undefined) {
    headers.set('x-acp-actor-agent-id', actorAgentId)
  }

  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers })
  } catch (error) {
    throw new AcpClientTransportError(`failed to reach ACP server at ${serverUrl}`, {
      cause: error,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    throw new AcpClientHttpError(response.status, body)
  }

  // -- Structured output (--json / --table): collect all events, then format.
  if (hasFlag(parsed, '--json') || hasFlag(parsed, '--table')) {
    const events: TailEvent[] = []

    if (response.body !== null) {
      for await (const event of streamNdjsonEvents(response.body)) {
        events.push(event)
      }
    } else {
      // Fallback: non-streaming runtime (some test harnesses return no body).
      const text = await response.text()
      events.push(...parseNdjsonText(text))
    }

    if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
      return asText(
        renderTable(
          [
            { header: 'Seq', value: (row: TailEvent) => String(row['hrcSeq'] ?? '') },
            { header: 'Kind', value: (row: TailEvent) => String(row['eventKind'] ?? '') },
            { header: 'Session', value: (row: TailEvent) => String(row['hostSessionId'] ?? '') },
            { header: 'Time', value: (row: TailEvent) => String(row['ts'] ?? '') },
          ],
          events
        )
      )
    }

    return { format: 'json', body: events }
  }

  // -- Default streaming mode: print each NDJSON record as it arrives.
  if (response.body !== null) {
    const lines: string[] = []
    for await (const event of streamNdjsonEvents(response.body)) {
      const line = JSON.stringify(event)
      process.stdout.write(`${line}\n`)
      lines.push(line)
    }
    // Return the text we already wrote so the caller's writeCommandOutput
    // doesn't double-print.  We use a sentinel empty-text result because
    // the lines were already flushed to stdout.
    return asText('')
  }

  // Fallback: non-streaming body.
  const text = await response.text()
  return asText(text)
}
