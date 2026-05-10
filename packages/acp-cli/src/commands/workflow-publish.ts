import { readFile } from 'node:fs/promises'

import { CliUsageError } from '../cli-runtime.js'
import type { FetchLike } from '../http-client.js'
import { hasFlag, parseArgs, readStringFlag } from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  resolveEnv,
  resolveServerUrl,
} from './shared.js'

export async function runWorkflowPublishCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--server', '--actor'],
    multiStringFlags: [],
  })

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('usage: acp workflow publish <workflow.json>')
  }
  const filePath = parsed.positionals[0]!

  let fileContent: string
  try {
    fileContent = await readFile(filePath, 'utf-8')
  } catch {
    throw new CliUsageError(`cannot read workflow file: ${filePath}`)
  }

  try {
    JSON.parse(fileContent)
  } catch {
    throw new CliUsageError(`workflow file is not valid JSON: ${filePath}`)
  }

  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch

  const response = await fetchImpl(`${serverUrl}/v1/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: fileContent,
  })

  const responseBody = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    const error = responseBody['error'] as { code?: string; message?: string } | undefined
    throw new CliUsageError(error?.message ?? `server returned ${response.status}`)
  }

  if (hasFlag(parsed, '--json')) {
    return asJson(responseBody)
  }

  const definition = responseBody['definition'] as { id?: string; version?: number; hash?: string }
  return asText(
    `Published workflow ${definition?.id ?? 'unknown'}@${definition?.version ?? '?'} (${definition?.hash ?? 'no hash'})`
  )
}
