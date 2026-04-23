import { hasFlag, parseArgs, requireNoPositionals } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'

import { resolveConcreteSessionId } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asText,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type CaptureResponse = {
  text: string
}

export async function runRenderCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--session', '--scope-ref', '--lane-ref', '--server', '--actor', '--project'],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('render help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)
  const sessionId = await resolveConcreteSessionId(parsed, deps)
  const capture = await requester.requestJson<CaptureResponse>({
    method: 'GET',
    path: `/v1/sessions/${encodeURIComponent(sessionId)}/capture`,
  })

  const body = {
    sessionId,
    frame: {
      kind: 'capture',
      text: capture.text,
    },
  }

  if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
    return asText(capture.text)
  }

  return renderJsonOrTable(parsed, body, () => capture.text)
}
