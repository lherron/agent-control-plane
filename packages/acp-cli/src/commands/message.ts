import {
  type ParsedArgs,
  hasFlag,
  parseArgs,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderTable } from '../output/table.js'

import { normalizeScopeInput } from '../scope-input.js'
import { requireMessageText } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type MessageParticipant =
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; humanId: string }
  | { kind: 'system' }
  | { kind: 'sessionRef'; sessionRef: { scopeRef: string; laneRef?: string | undefined } }

type MessageResponse = Record<string, unknown>

function normalizeSessionParticipant(scopeInput: string, laneRef?: string): MessageParticipant {
  try {
    return { kind: 'sessionRef', sessionRef: normalizeScopeInput(scopeInput, laneRef) }
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}

function resolveFromParticipant(parsed: ParsedArgs): MessageParticipant {
  const agentId = parsed.stringFlags['--from-agent']
  const humanId = parsed.stringFlags['--from-human']
  const sessionRef = parsed.stringFlags['--from-session']
  const system = hasFlag(parsed, '--from-system')
  const matches = [agentId, humanId, sessionRef, system ? 'system' : undefined].filter(
    (value) => value !== undefined
  )

  if (matches.length > 1) {
    throw new CliUsageError('choose only one from-participant flag')
  }

  if (agentId !== undefined) {
    return { kind: 'agent', agentId }
  }
  if (humanId !== undefined) {
    return { kind: 'human', humanId }
  }
  if (sessionRef !== undefined) {
    return normalizeSessionParticipant(sessionRef, parsed.stringFlags['--from-lane-ref'])
  }
  if (system) {
    return { kind: 'system' }
  }

  const actor = parsed.stringFlags['--actor']?.trim()
  if (actor && actor.length > 0) {
    return { kind: 'agent', agentId: actor }
  }

  throw new CliUsageError(
    'one of --from-agent, --from-human, --from-session, --from-system, or --actor is required'
  )
}

function resolveSingleRecipient(parsed: ParsedArgs): MessageParticipant {
  const agentIds = parsed.multiStringFlags['--to-agent'] ?? []
  const humanIds = parsed.multiStringFlags['--to-human'] ?? []
  const sessionRefs = parsed.multiStringFlags['--to-session'] ?? []
  const system = hasFlag(parsed, '--to-system')
  const matches = agentIds.length + humanIds.length + sessionRefs.length + (system ? 1 : 0)

  if (matches !== 1) {
    throw new CliUsageError(
      'exactly one of --to-agent, --to-human, --to-session, or --to-system is required'
    )
  }

  const agentId = agentIds[0]
  if (agentId !== undefined) {
    return { kind: 'agent', agentId }
  }
  const humanId = humanIds[0]
  if (humanId !== undefined) {
    return { kind: 'human', humanId }
  }
  const sessionRef = sessionRefs[0]
  if (sessionRef !== undefined) {
    return normalizeSessionParticipant(sessionRef, parsed.stringFlags['--to-lane-ref'])
  }

  return { kind: 'system' }
}

function resolveBroadcastRecipients(parsed: ParsedArgs): MessageParticipant[] {
  const recipients: MessageParticipant[] = []

  for (const agentId of parsed.multiStringFlags['--to-agent'] ?? []) {
    recipients.push({ kind: 'agent', agentId })
  }
  for (const humanId of parsed.multiStringFlags['--to-human'] ?? []) {
    recipients.push({ kind: 'human', humanId })
  }
  for (const sessionRef of parsed.multiStringFlags['--to-session'] ?? []) {
    recipients.push(normalizeSessionParticipant(sessionRef, parsed.stringFlags['--to-lane-ref']))
  }
  if (hasFlag(parsed, '--to-system')) {
    recipients.push({ kind: 'system' })
  }

  if (recipients.length === 0) {
    throw new CliUsageError('broadcast requires at least one recipient flag')
  }

  return recipients
}

function buildMessageBody(parsed: ParsedArgs, to: MessageParticipant): Record<string, unknown> {
  return {
    projectId: requireStringFlag(parsed, '--project'),
    from: resolveFromParticipant(parsed),
    to,
    body: requireMessageText(parsed),
    options: {
      ...(hasFlag(parsed, '--wake') ? { wake: true } : {}),
      ...(hasFlag(parsed, '--dispatch') ? { dispatch: true } : {}),
      ...(hasFlag(parsed, '--coordination-only') ? { coordinationOnly: true } : {}),
    },
  }
}

function renderResultsTable(results: Array<Record<string, unknown>>): string {
  return renderTable(
    [
      { header: 'Message', value: (row) => String(row['messageId'] ?? '') },
      { header: 'Coordination', value: (row) => String(row['coordinationEventId'] ?? '') },
      { header: 'Run', value: (row) => String(row['runId'] ?? '') },
      { header: 'Wake', value: (row) => String(row['wakeRequestId'] ?? '') },
    ],
    results
  )
}

export async function runMessageCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: [
      '--json',
      '--table',
      '--wake',
      '--dispatch',
      '--coordination-only',
      '--from-system',
      '--to-system',
    ],
    stringFlags: [
      '--server',
      '--actor',
      '--project',
      '--text',
      '--from-agent',
      '--from-human',
      '--from-session',
      '--from-lane-ref',
      '--to-lane-ref',
    ],
    multiStringFlags: ['--to-agent', '--to-human', '--to-session'],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('message help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'send') {
    const response = await requester.requestJson<MessageResponse>({
      method: 'POST',
      path: '/v1/coordination/messages',
      body: buildMessageBody(parsed, resolveSingleRecipient(parsed)),
    })
    if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
      return asText(renderResultsTable([response]))
    }
    return asJson(response)
  }

  if (subcommand === 'broadcast') {
    const recipients = resolveBroadcastRecipients(parsed)
    const results: MessageResponse[] = []
    for (const recipient of recipients) {
      results.push(
        await requester.requestJson<MessageResponse>({
          method: 'POST',
          path: '/v1/coordination/messages',
          body: buildMessageBody(parsed, recipient),
        })
      )
    }

    const body = { results }
    if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
      return asText(renderResultsTable(results))
    }
    return asJson(body)
  }

  throw new CliUsageError(`unknown message subcommand: ${subcommand}`)
}
