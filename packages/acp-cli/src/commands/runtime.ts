import { hasFlag, parseArgs, requireNoPositionals } from '../cli-args.js'

import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable } from '../output/table.js'
import { requireSessionRefFlags } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type RuntimeResolveResponse = {
  placement: Record<string, unknown>
}

export async function runRuntimeCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand !== 'resolve') {
    throw new CliUsageError(`unknown runtime subcommand: ${subcommand}`)
  }

  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--scope-ref', '--lane-ref', '--server', '--actor', '--project'],
  })
  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('runtime help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)
  const response = await requester.requestJson<RuntimeResolveResponse>({
    method: 'POST',
    path: '/v1/runtime/resolve',
    body: {
      sessionRef: requireSessionRefFlags(parsed),
    },
  })

  return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.placement))
}
