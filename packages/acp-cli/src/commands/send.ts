import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable } from '../output/table.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'

import { requireMessageText, requireSessionRefFlags } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  maybeParseMetaFlag,
  renderJsonOrTable,
} from './shared.js'

type InputResponse = {
  inputAttempt: Record<string, unknown>
  run: Record<string, unknown>
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function readOptionalInteger(
  parsed: ReturnType<typeof parseArgs>,
  flag: '--wait-timeout-ms' | '--wait-interval-ms'
): number | undefined {
  const raw = parsed.stringFlags[flag]
  return raw === undefined ? undefined : parseIntegerValue(flag, raw, { min: 1 })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  const requester = createRawRequesterFromParsed(parsed, deps)
  const response = await requester.requestJson<InputResponse>({
    method: 'POST',
    path: '/v1/inputs',
    body: {
      sessionRef: requireSessionRefFlags(parsed),
      content: requireMessageText(parsed),
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

  const deadline = Date.now() + waitTimeoutMs
  let latestRun = response.run
  let timedOut = false
  while (!TERMINAL_RUN_STATUSES.has(String(latestRun['status'] ?? ''))) {
    if (Date.now() >= deadline) {
      timedOut = true
      break
    }

    await sleep(waitIntervalMs)
    const polled = await requester.requestJson<{ run: Record<string, unknown> }>({
      method: 'GET',
      path: `/v1/runs/${encodeURIComponent(runId)}`,
    })
    latestRun = polled.run
  }

  const body = {
    ...response,
    run: latestRun,
    ...(timedOut ? { timedOut: true } : {}),
  }

  return renderJsonOrTable(parsed, body, () => {
    return renderKeyValueTable({
      inputAttemptId: body.inputAttempt['inputAttemptId'],
      runId: body.run['runId'],
      status: body.run['status'],
      ...(timedOut ? { timedOut: true } : {}),
    })
  })
}
