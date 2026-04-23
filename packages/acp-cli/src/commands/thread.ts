import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'

import { readSessionRefFlags } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type ThreadRecord = Record<string, unknown>
type TurnRecord = Record<string, unknown>
type ThreadListResponse = { threads: ThreadRecord[] }
type ThreadShowResponse = { thread: ThreadRecord }
type ThreadTurnsResponse = { turns: TurnRecord[] }

export async function runThreadCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: [
      '--thread',
      '--project',
      '--scope-ref',
      '--lane-ref',
      '--since',
      '--limit',
      '--server',
      '--actor',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('thread help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)
  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'list') {
    const query = new URLSearchParams()
    if (parsed.stringFlags['--project'] !== undefined) {
      query.set('projectId', requireStringFlag(parsed, '--project'))
    }

    const sessionRef = readSessionRefFlags(parsed)
    if (sessionRef?.scopeRef !== undefined) {
      query.set('scopeRef', sessionRef.scopeRef)
      query.set('laneRef', sessionRef.laneRef ?? 'main')
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await requester.requestJson<ThreadListResponse>({
      method: 'GET',
      path: `/v1/conversation/threads${suffix}`,
    })

    return renderJsonOrTable(parsed, response, () => {
      return renderTable(
        [
          { header: 'Thread', value: (row: ThreadRecord) => String(row['threadId'] ?? '') },
          { header: 'Gateway', value: (row: ThreadRecord) => String(row['gatewayId'] ?? '') },
          {
            header: 'Conversation',
            value: (row: ThreadRecord) => String(row['conversationRef'] ?? ''),
          },
          { header: 'Audience', value: (row: ThreadRecord) => String(row['audience'] ?? '') },
        ],
        response.threads
      )
    })
  }

  if (subcommand === 'show') {
    const response = await requester.requestJson<ThreadShowResponse>({
      method: 'GET',
      path: `/v1/conversation/threads/${encodeURIComponent(requireStringFlag(parsed, '--thread'))}`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.thread))
  }

  if (subcommand === 'turns') {
    const query = new URLSearchParams()
    if (parsed.stringFlags['--since'] !== undefined) {
      query.set('since', requireStringFlag(parsed, '--since'))
    }
    if (parsed.stringFlags['--limit'] !== undefined) {
      query.set(
        'limit',
        String(parseIntegerValue('--limit', requireStringFlag(parsed, '--limit'), { min: 1 }))
      )
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await requester.requestJson<ThreadTurnsResponse>({
      method: 'GET',
      path: `/v1/conversation/threads/${encodeURIComponent(requireStringFlag(parsed, '--thread'))}/turns${suffix}`,
    })

    return renderJsonOrTable(parsed, response, () => {
      return renderTable(
        [
          { header: 'Turn', value: (row: TurnRecord) => String(row['turnId'] ?? '') },
          {
            header: 'Role',
            value: (row: TurnRecord) => String(row['role'] ?? row['author'] ?? ''),
          },
          { header: 'State', value: (row: TurnRecord) => String(row['renderState'] ?? '') },
          {
            header: 'Sent',
            value: (row: TurnRecord) => String(row['sentAt'] ?? row['createdAt'] ?? ''),
          },
        ],
        response.turns
      )
    })
  }

  throw new CliUsageError(`unknown thread subcommand: ${subcommand}`)
}
