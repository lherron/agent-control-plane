/**
 * `acp c2 scope show|set` — the C2 scope row on the Vesta seat (C2 rev 4 D5,
 * T-12207). It talks to the local HRC socket directly through acp-server's
 * scope helpers (hrc-sdk), writing as `agent:lance`; it never goes through an
 * ACP route. An absent row allows nothing.
 */
import {
  type C2ScopeClient,
  type C2ScopeRow,
  createC2ScopeClient,
  readC2Scope,
  resolveVestaSeat,
  validateScopeAllow,
  writeC2Scope,
} from 'acp-server'

import { CliUsageError } from '../cli-runtime.js'

import { parseArgs, readMultiStringFlag, readStringFlag, requireNoPositionals } from './options.js'
import { renderJsonOrTable } from './shared.js'

import type { CommandDependencies, CommandOutput } from './shared.js'

export type C2CommandDependencies = CommandDependencies & {
  c2ScopeClient?: C2ScopeClient | undefined
}

function renderScope(row: C2ScopeRow): string {
  const lines = [`vesta seat: ${row.vestaSeat}`]
  if (!row.present) {
    lines.push('scope: absent (allows nothing)')
    return lines.join('\n')
  }
  lines.push(`updated:    ${row.updatedAt ?? '-'} by ${row.updatedBy ?? '-'}`, 'allow:')
  for (const pattern of row.allow) lines.push(`  ${pattern}`)
  if (row.allow.length === 0) lines.push('  (empty: allows nothing)')
  return lines.join('\n')
}

export async function runC2Command(
  args: string[],
  deps: C2CommandDependencies = {}
): Promise<CommandOutput> {
  const [group, subcommand] = args
  if (group !== 'scope') throw new CliUsageError(`unknown c2 command: ${group ?? ''}`)
  const parsed = parseArgs(args.slice(2), {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--vesta-seat'],
    multiStringFlags: ['--allow'],
  })
  requireNoPositionals(parsed)
  const vestaSeat = resolveVestaSeat(
    readStringFlag(parsed, '--vesta-seat'),
    deps.env ?? process.env
  )
  const client = deps.c2ScopeClient ?? createC2ScopeClient()

  if (subcommand === 'show') {
    const row = await readC2Scope(client, vestaSeat)
    return renderJsonOrTable(parsed, row, () => renderScope(row))
  }
  if (subcommand === 'set') {
    const allow = readMultiStringFlag(parsed, '--allow')
    if (allow.length === 0) throw new CliUsageError('--allow <regex> is required (repeatable)')
    const invalid = validateScopeAllow(allow)
    if (invalid !== undefined) throw new CliUsageError(invalid)
    const row = await writeC2Scope(client, vestaSeat, allow)
    return renderJsonOrTable(parsed, row, () => renderScope(row))
  }
  throw new CliUsageError(`unknown c2 scope subcommand: ${subcommand ?? ''}`)
}
