import type { EvidenceItem } from 'acp-core'

import { renderAttachedEvidence } from '../output/evidence-render.js'
import { normalizeRoleName } from '../roles.js'
import {
  hasFlag,
  parseArgs,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  getClientFactory,
  maybeParseMetaFlag,
  requireActorAgentId,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

function buildEvidence(input: {
  actorAgentId: string
  producerRole: string
  kind: string
  ref: string
  contentHash?: string | undefined
  buildId?: string | undefined
  buildVersion?: string | undefined
  buildEnv?: string | undefined
  meta?: Record<string, unknown> | undefined
}): EvidenceItem {
  return {
    kind: input.kind,
    ref: input.ref,
    producedBy: {
      agentId: input.actorAgentId,
      role: input.producerRole,
    },
    ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
    ...(input.buildId !== undefined ||
    input.buildVersion !== undefined ||
    input.buildEnv !== undefined
      ? {
          build: {
            ...(input.buildId !== undefined ? { id: input.buildId } : {}),
            ...(input.buildVersion !== undefined ? { version: input.buildVersion } : {}),
            ...(input.buildEnv !== undefined ? { env: input.buildEnv } : {}),
          },
        }
      : {}),
    ...(input.meta !== undefined ? { details: input.meta } : {}),
  }
}

export async function runTaskEvidenceAddCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--kind',
      '--ref',
      '--actor',
      '--producer-role',
      '--build-id',
      '--build-version',
      '--build-env',
      '--content-hash',
      '--meta',
      '--server',
    ],
  })
  requireNoPositionals(parsed)

  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const producerRole = normalizeRoleName(
    requireStringFlag(parsed, '--producer-role'),
    '--producer-role'
  )
  const taskId = requireStringFlag(parsed, '--task')
  const evidence = buildEvidence({
    actorAgentId,
    producerRole,
    kind: requireStringFlag(parsed, '--kind'),
    ref: requireStringFlag(parsed, '--ref'),
    ...(readStringFlag(parsed, '--content-hash') !== undefined
      ? { contentHash: readStringFlag(parsed, '--content-hash') }
      : {}),
    ...(readStringFlag(parsed, '--build-id') !== undefined
      ? { buildId: readStringFlag(parsed, '--build-id') }
      : {}),
    ...(readStringFlag(parsed, '--build-version') !== undefined
      ? { buildVersion: readStringFlag(parsed, '--build-version') }
      : {}),
    ...(readStringFlag(parsed, '--build-env') !== undefined
      ? { buildEnv: readStringFlag(parsed, '--build-env') }
      : {}),
    ...(maybeParseMetaFlag(parsed) !== undefined ? { meta: maybeParseMetaFlag(parsed) } : {}),
  })

  const client = getClientFactory(deps)({ serverUrl, actorAgentId })
  const response = await client.addEvidence({
    actorAgentId,
    taskId,
    evidence: [evidence],
  })

  return hasFlag(parsed, '--json')
    ? asJson(response)
    : asText(renderAttachedEvidence({ taskId, evidence }))
}
