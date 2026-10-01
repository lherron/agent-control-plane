#!/usr/bin/env bun
import { createClient } from '@wrkq/client'

import { RECONCILER_DEFAULTS, readReconcilerConfig } from './config.js'
import { type ReconcilerReader, createHrcPort, createWrkqReader } from './ports.js'
import { type ExplainResult, explainWith } from './reconciler.js'

const USAGE = `Usage: acp-reconciler explain [<task-id>] [--json]

Read-only: evaluates every delegated request (meta.acp.request) exactly as the
running reconciler would and prints why each one starts, waits, is active,
invalid or stalled, with reservation and stall evidence. Writes nothing.
Capacity and claim window come from ACP_RECONCILER_* (defaults when unset).`

export function renderExplain(result: ExplainResult): string {
  const lines = [
    `acp-reconciler explain @ ${result.at} on ${result.localNodeId} (capacity ${result.capacity.global} total / ${result.capacity.perAgent} per agent, claim window ${result.capacity.claimWindowMs}ms)`,
  ]
  if (result.decisions.length === 0) lines.push('  no delegated requests')
  for (const decision of result.decisions) {
    const verb = decision.kind === 'stall' && decision.reported ? 'stall (reported)' : decision.kind
    lines.push(`  ${decision.id}  ${verb}  ${decision.reason}`)
    if (decision.kind === 'start') lines.push(`      start_key=${decision.startKey}`)
    if (decision.kind === 'stall') lines.push(`      stall_key=${decision.stall.key}`)
    for (const [key, value] of Object.entries(decision.evidence ?? {})) {
      lines.push(`      ${key}=${value}`)
    }
  }
  return lines.join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  if (command !== 'explain') {
    console.error(USAGE)
    return 2
  }
  let json = false
  let taskId: string | undefined
  for (const arg of rest) {
    if (arg === '--json') json = true
    else if (!arg.startsWith('-') && taskId === undefined) taskId = arg
    else {
      console.error(`acp-reconciler: unexpected argument ${arg}\n${USAGE}`)
      return 2
    }
  }

  const config = readReconcilerConfig(process.env) ?? { ...RECONCILER_DEFAULTS, node: '' }
  const client = await createClient({
    command: 'wrkq',
    principalRef: config.principalRef,
    clientInfo: { name: 'acp-reconciler', version: '0.1.0' },
    env: process.env,
  })
  try {
    const hrc = createHrcPort({ principalRef: config.principalRef })
    const wrkq = createWrkqReader(client)
    // Only the read half of each port is wired: explain cannot write.
    const reader: ReconcilerReader = {
      localNodeId: hrc.localNodeId,
      listRequests: wrkq.listRequests,
      readFacts: wrkq.readFacts,
      holderLiveness: hrc.holderLiveness,
      workerValidity: hrc.workerValidity,
    }
    const result = await explainWith(reader, config, () => new Date(), taskId)
    console.log(json ? JSON.stringify(result, null, 2) : renderExplain(result))
    return 0
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
