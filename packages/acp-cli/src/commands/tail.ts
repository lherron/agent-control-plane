import { hasFlag, parseArgs, parseIntegerValue, requireNoPositionals } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderTable } from '../output/table.js'

import { resolveConcreteSessionId } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type TailEvent = Record<string, unknown>

function parseEvents(text: string): TailEvent[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TailEvent)
}

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

  const requester = createRawRequesterFromParsed(parsed, deps)
  const sessionId = await resolveConcreteSessionId(parsed, deps)
  const query = new URLSearchParams()
  if (parsed.stringFlags['--from-seq'] !== undefined) {
    query.set(
      'fromSeq',
      String(parseIntegerValue('--from-seq', parsed.stringFlags['--from-seq'], { min: 0 }))
    )
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const text = await requester.requestText({
    method: 'GET',
    path: `/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`,
  })

  if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
    const events = parseEvents(text)
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

  if (hasFlag(parsed, '--json')) {
    return { format: 'json', body: parseEvents(text) }
  }

  return asText(text)
}
