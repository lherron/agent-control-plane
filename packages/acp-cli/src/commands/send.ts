import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable } from '../output/table.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import { TERMINAL_STATUSES, pollUntilTerminal } from './poll.js'

import { requireMessageText, requireSessionRefFlags } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  maybeParseMetaFlag,
  renderJsonOrTable,
  resolveEnv,
} from './shared.js'

type InputResponse = {
  inputAttempt: Record<string, unknown>
  run: Record<string, unknown>
}

type OutboundMessageResponse = {
  deliveryRequestId: string
  status: string
  body: {
    kind: string
    text: string
  }
}

function readOptionalInteger(
  parsed: ReturnType<typeof parseArgs>,
  flag: '--wait-timeout-ms' | '--wait-interval-ms'
): number | undefined {
  const raw = parsed.stringFlags[flag]
  return raw === undefined ? undefined : parseIntegerValue(flag, raw, { min: 1 })
}

export async function runSendCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--table', '--wait', '--no-dispatch'],
    stringFlags: [
      '--scope-ref',
      '--lane-ref',
      '--text',
      '--idempotency-key',
      '--meta',
      '--server',
      '--actor',
      '--project',
      '--wait-timeout-ms',
      '--wait-interval-ms',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('send help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const requester = createRawRequesterFromParsed(parsed, deps)
  const text = requireMessageText(parsed)
  const scopeRef = parsed.stringFlags['--scope-ref']

  if (scopeRef === undefined) {
    const acpRunId = env['ACP_RUN_ID']
    const currentRunId = acpRunId ?? env['HRC_RUN_ID']
    if (currentRunId === undefined || currentRunId.trim().length === 0) {
      throw new CliUsageError('--scope-ref is required outside an active ACP/HRC run')
    }

    const response = await requester.requestJson<OutboundMessageResponse>({
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(currentRunId.trim())}/outbound-messages`,
      headers: correlationHeadersFromEnv(env, { includeHrcRunId: acpRunId === undefined }),
      body: { text },
    })

    return renderJsonOrTable(parsed, response, () => {
      return renderKeyValueTable({
        deliveryRequestId: response.deliveryRequestId,
        status: response.status,
      })
    })
  }

  const response = await requester.requestJson<InputResponse>({
    method: 'POST',
    path: '/v1/inputs',
    body: {
      sessionRef: requireSessionRefFlags(parsed),
      content: text,
      ...(parsed.stringFlags['--idempotency-key'] !== undefined
        ? { idempotencyKey: requireStringFlag(parsed, '--idempotency-key') }
        : {}),
      ...(maybeParseMetaFlag(parsed) !== undefined ? { meta: maybeParseMetaFlag(parsed) } : {}),
      ...(hasFlag(parsed, '--no-dispatch') ? { dispatch: false } : {}),
    },
  })

  if (!hasFlag(parsed, '--wait')) {
    return renderJsonOrTable(parsed, response, () => {
      return renderKeyValueTable({
        inputAttemptId: response.inputAttempt['inputAttemptId'],
        runId: response.run['runId'],
        status: response.run['status'],
      })
    })
  }

  const waitTimeoutMs = readOptionalInteger(parsed, '--wait-timeout-ms') ?? 30_000
  const waitIntervalMs = readOptionalInteger(parsed, '--wait-interval-ms') ?? 500
  const runId = String(response.run['runId'] ?? '')
  if (runId.length === 0) {
    throw new CliUsageError('send --wait requires the server to return run.runId')
  }

  const result = await pollUntilTerminal({
    initial: response.run,
    isTerminal: (run) => TERMINAL_STATUSES.has(String(run['status'] ?? '')),
    pollFn: async () => {
      const polled = await requester.requestJson<{ run: Record<string, unknown> }>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId)}`,
      })
      return polled.run
    },
    intervalMs: waitIntervalMs,
    timeoutMs: waitTimeoutMs,
  })

  const body = {
    ...response,
    run: result.latest,
    ...(result.timedOut ? { timedOut: true } : {}),
  }

  return renderJsonOrTable(parsed, body, () => {
    return renderKeyValueTable({
      inputAttemptId: body.inputAttempt['inputAttemptId'],
      runId: body.run['runId'],
      status: body.run['status'],
      ...(result.timedOut ? { timedOut: true } : {}),
    })
  })
}

function correlationHeadersFromEnv(
  env: NodeJS.ProcessEnv,
  options: { includeHrcRunId: boolean }
): Record<string, string> {
  const headers: Record<string, string> = {}
  const add = (header: string, value: string | undefined): void => {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed.length > 0) {
      headers[header] = trimmed
    }
  }

  if (options.includeHrcRunId) {
    add('HRC_RUN_ID', env['HRC_RUN_ID'])
  }
  add('HRC_HOST_SESSION_ID', env['HRC_HOST_SESSION_ID'])
  add('HRC_GENERATION', env['HRC_GENERATION'])
  return headers
}
