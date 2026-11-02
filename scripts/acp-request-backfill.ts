#!/usr/bin/env bun
/** M5 phase c. Product maintenance entrypoint, NOT a caller-identity override.
 * Default reads only. Live invocation requires an admitted acp-reconciler caller.
 * Plan: --db <locator> [--output plan.json]
 * Apply: --db <same locator> --manifest plan.json --expect-sha256 <digest> --apply
 * Never install, start workers, mutate task/meta, or rescan subjects during apply.
 */
import { createClient } from '@wrkq/client'
import {
  BACKFILL_PRINCIPAL,
  BackfillFailure,
  applyBackfill,
  planBackfill,
  validateManifest,
} from 'acp-reconciler'
export {
  BACKFILL_PRINCIPAL,
  BackfillFailure,
  applyBackfill,
  planBackfill,
  validateManifest,
} from 'acp-reconciler'
export type { BackfillRow, BackfillManifest } from 'acp-reconciler'

export async function main(argv: string[]) {
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const value = argv[i + 1]
    if (arg === '--apply' && !apply) {
      apply = true
      continue
    }
    if (
      !['--db', '--output', '--manifest', '--expect-sha256'].includes(arg) ||
      values.has(arg) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(`invalid argument: ${arg}`)
    values.set(arg, value)
    i++
  }
  const target = values.get('--db')
  if (
    !target ||
    (apply && (!values.has('--manifest') || !values.has('--expect-sha256'))) ||
    (!apply && (values.has('--manifest') || values.has('--expect-sha256')))
  ) {
    throw new Error('dry-run requires --db; --apply requires --db --manifest --expect-sha256')
  }
  const manifestPath = values.get('--manifest')
  const expected = values.get('--expect-sha256')
  // Validate before opening any transport. No --as or caller credential mutation.
  const manifest =
    apply && manifestPath && expected
      ? validateManifest(await Bun.file(manifestPath).json(), target, expected)
      : undefined
  const client = await createClient({
    command: 'wrkq',
    dbLocator: target,
    principalRef: BACKFILL_PRINCIPAL,
    clientInfo: { name: 'acp-request-backfill', version: '1' },
  })
  try {
    const report = manifest
      ? await applyBackfill(client, manifest, target, manifest.sha256)
      : await planBackfill(client, target)
    const json = `${JSON.stringify(report, null, 2)}\n`
    const output = values.get('--output')
    if (output) await Bun.write(output, json)
    console.log(json)
  } finally {
    await client.close()
  }
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    if (error instanceof BackfillFailure) console.error(JSON.stringify(error.progress))
    process.exitCode = 1
  })
}
