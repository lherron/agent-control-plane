import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'

import { createAdminClient } from './admin-interface-binding-shared.js'
import { type CommandDependencies, type CommandOutput, asJson, asText } from './shared.js'

export async function runAdminInterfaceBindingDisableCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--gateway', '--conversation-ref', '--thread-ref', '--server', '--actor'],
  })
  requireNoPositionals(parsed)

  const gatewayId = requireStringFlag(parsed, '--gateway')
  const conversationRef = requireStringFlag(parsed, '--conversation-ref')
  const threadRef = parsed.stringFlags['--thread-ref']
  const client = createAdminClient(parsed, deps)
  const listed = await client.listInterfaceBindings({
    gatewayId,
    conversationRef,
    ...(threadRef !== undefined ? { threadRef } : {}),
  })

  if (listed.bindings.length === 0) {
    throw new CliUsageError('no interface binding found for the provided lookup')
  }

  if (listed.bindings.length > 1) {
    throw new CliUsageError('multiple interface bindings matched; refine the lookup')
  }

  const existing = listed.bindings[0]
  if (existing === undefined) {
    throw new CliUsageError('no interface binding found for the provided lookup')
  }

  const response = await client.upsertInterfaceBinding({
    gatewayId: existing.gatewayId,
    conversationRef: existing.conversationRef,
    ...(existing.threadRef !== undefined ? { threadRef: existing.threadRef } : {}),
    ...(existing.projectId !== undefined ? { projectId: existing.projectId } : {}),
    sessionRef: {
      scopeRef: existing.sessionRef.scopeRef,
      laneRef: existing.sessionRef.laneRef,
    },
    status: 'disabled',
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(`Disabled binding ${response.binding.bindingId}`)
}
