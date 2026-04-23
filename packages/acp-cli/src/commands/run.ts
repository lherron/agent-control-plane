import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable } from '../output/table.js'

import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type RunResponse = {
  run: Record<string, unknown>
}

export async function runRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--run', '--server', '--actor', '--project'],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('run help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)
  const runId = requireStringFlag(parsed, '--run')

  if (subcommand === 'show') {
    const response = await requester.requestJson<RunResponse>({
      method: 'GET',
      path: `/v1/runs/${encodeURIComponent(runId)}`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.run))
  }

  if (subcommand === 'cancel') {
    const response = await requester.requestJson<RunResponse>({
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.run))
  }

  throw new CliUsageError(`unknown run subcommand: ${subcommand}`)
}
