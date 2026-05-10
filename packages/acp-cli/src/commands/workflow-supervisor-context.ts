import {
  hasFlag,
  parseArgs,
  parseJsonObject,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

export async function runWorkflowSupervisorContextCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--actor',
      '--run',
      '--autonomy',
      '--capabilities',
      '--idempotency-prefix',
      '--server',
    ],
  })
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps, { requireActor: true })
  const response = await requester.requestJson<unknown>({
    method: 'POST',
    path: `/v1/tasks/${encodeURIComponent(requireStringFlag(parsed, '--task'))}/supervisor-context`,
    body: {
      runId: requireStringFlag(parsed, '--run'),
      actor: { kind: 'agent', id: requireStringFlag(parsed, '--actor') },
      autonomy: readStringFlag(parsed, '--autonomy') ?? 'managed',
      capabilities:
        readStringFlag(parsed, '--capabilities') === undefined
          ? {}
          : parseJsonObject('--capabilities', requireStringFlag(parsed, '--capabilities')),
      idempotencyPrefix: requireStringFlag(parsed, '--idempotency-prefix'),
    },
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  return asText(JSON.stringify(response, null, 2))
}
