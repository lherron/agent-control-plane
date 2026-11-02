#!/usr/bin/env bun
/** M5 phase c. Product maintenance entrypoint, NOT a caller-identity override.
 * Default reads only. Live invocation requires an admitted acp-reconciler caller.
 * Plan: --db <locator> [--output plan.json]
 * Apply: --db <same locator> --manifest plan.json --expect-sha256 <digest> --apply
 * Never install, start workers, mutate task/meta, or rescan subjects during apply.
 */
import { createHash } from 'node:crypto'
import { type WorkClient, WorkRpcError, createClient } from '@wrkq/client'
import type { WrkqTaskState } from '@wrkq/client/wrkq'
import { parseRequestBody, parseRequestMarker } from '../packages/acp-reconciler/src/model.js'

export const BACKFILL_PRINCIPAL = 'agent:acp-reconciler'
const KEY = { ns: 'acp', kind: 'request', id: 'main' } as const
const STATES: WrkqTaskState[] = [
  'idea',
  'draft',
  'open',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
  'archived',
  'deleted',
]
type ExtSnapshot = { rev: number; etag: number } | null
export type BackfillRow = {
  task: string
  uuid: string
  taskEtag: number
  state: WrkqTaskState
  metaRev: number
  ext: ExtSnapshot
  targetRev: number
  write: boolean
}
export type BackfillManifest = {
  schema: 'acp-request-backfill/v1'
  target: string
  principal: typeof BACKFILL_PRINCIPAL
  scanned: number
  pages: number
  rows: BackfillRow[]
  sha256: string
}
type Client = Pick<WorkClient, 'wrkq'>
type Progress = {
  written: number
  eventsCreated: number
  results: { task: string; put: boolean; event: string; eventCreated: boolean }[]
}
export class BackfillFailure extends Error {
  constructor(
    message: string,
    readonly progress: Progress,
    cause: unknown
  ) {
    super(message, { cause })
  }
}
function digest(value: Omit<BackfillManifest, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function revision(body: unknown): number {
  const parsed = parseRequestBody(body)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.rev
}
function metaRevision(meta: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(meta, 'acp')) return undefined
  const marker = parseRequestMarker(meta)
  if (!marker?.ok) throw new Error(marker?.reason ?? 'malformed meta.acp.request')
  return marker.rev
}
async function readExt(client: Client, task: string): Promise<ExtSnapshot> {
  try {
    const { ext } = await client.wrkq.ext.show({ subject: { task }, ...KEY })
    if (!positive(ext.etag)) throw new Error(`invalid extension fence for ${task}`)
    return { rev: revision(ext.body), etag: ext.etag }
  } catch (error) {
    if (error instanceof WorkRpcError && error.domainCode === 'WRKQ_NOT_FOUND') return null
    throw error
  }
}

/** Full history, no assignee/path filter, named subtasks included; never writes. */
export async function planBackfill(client: Client, target: string): Promise<BackfillManifest> {
  const rows: BackfillRow[] = []
  const seenTasks = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await client.wrkq.task.list({
      subtasks: true,
      includeDeleted: true,
      state: STATES,
      summary: true,
      sort: 'id',
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    })
    pages++
    for (const task of page.items) {
      if (seenTasks.has(task.id)) throw new Error(`duplicate task during census: ${task.id}`)
      seenTasks.add(task.id)
      if (metaRevision(task.meta ?? {}) === undefined) continue
      // Bind the plan to a fresh owner body, including task identity/state/fence.
      const current = await client.wrkq.task.show({ task: task.id })
      const metaRev = metaRevision(current.meta ?? {})
      if (metaRev === undefined) throw new Error(`meta changed during census: ${task.id}`)
      const ext = await readExt(client, task.id)
      if (!positive(current.etag)) throw new Error(`invalid task fence: ${task.id}`)
      const targetRev = Math.max(metaRev, ext?.rev ?? 0)
      rows.push({
        task: current.id,
        uuid: current.uuid,
        taskEtag: current.etag,
        state: current.state,
        metaRev,
        ext,
        targetRev,
        write: ext === null || ext.rev < targetRev,
      })
    }
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('repeated census cursor')
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  rows.sort((a, b) => a.task.localeCompare(b.task))
  const manifest: Omit<BackfillManifest, 'sha256'> = {
    schema: 'acp-request-backfill/v1',
    target,
    principal: BACKFILL_PRINCIPAL,
    scanned: seenTasks.size,
    pages,
    rows,
  }
  return { ...manifest, sha256: digest(manifest) }
}

/** Validate untrusted on-disk manifests and operator-reviewed content digest. */
export function validateManifest(
  value: unknown,
  target: string,
  expected: string
): BackfillManifest {
  if (value === null || typeof value !== 'object') throw new Error('invalid manifest')
  const manifest = value as BackfillManifest
  const { sha256, ...content } = manifest
  if (
    manifest.schema !== 'acp-request-backfill/v1' ||
    manifest.target !== target ||
    manifest.principal !== BACKFILL_PRINCIPAL ||
    sha256 !== expected ||
    digest(content) !== expected ||
    !Array.isArray(manifest.rows) ||
    !positive(manifest.pages) ||
    !Number.isSafeInteger(manifest.scanned) ||
    manifest.scanned < manifest.rows.length
  ) {
    throw new Error('manifest schema, target, principal or digest mismatch')
  }
  const seen = new Set<string>()
  for (const row of manifest.rows) {
    if (
      !/^T-\d+(?:\.[a-z0-9_-]+)?$/.test(row.task) ||
      typeof row.uuid !== 'string' ||
      !row.uuid ||
      !positive(row.taskEtag) ||
      !STATES.includes(row.state) ||
      !positive(row.metaRev) ||
      (row.ext !== null && (!positive(row.ext?.rev) || !positive(row.ext?.etag))) ||
      row.targetRev !== Math.max(row.metaRev, row.ext?.rev ?? 0) ||
      row.write !== (row.ext === null || row.ext.rev < row.targetRev) ||
      seen.has(row.task)
    ) {
      throw new Error('invalid or duplicate manifest row')
    }
    seen.add(row.task)
  }
  return manifest
}
function sameExt(a: ExtSnapshot, b: ExtSnapshot): boolean {
  return a === null ? b === null : b !== null && a.rev === b.rev && a.etag === b.etag
}
async function checkRow(client: Client, row: BackfillRow): Promise<boolean> {
  const current = await client.wrkq.task.show({ task: row.task })
  if (
    current.uuid !== row.uuid ||
    current.etag !== row.taskEtag ||
    current.state !== row.state ||
    metaRevision(current.meta ?? {}) !== row.metaRev
  )
    throw new Error(`task drift: ${row.task}`)
  const ext = await readExt(client, row.task)
  if (sameExt(row.ext, ext)) return row.write
  // Resume the same manifest after put success / lost answer / event failure.
  // Only the exact expected post-put state qualifies, never an arbitrary newer row.
  if (row.write && sameExt(ext, { rev: row.targetRev, etag: (row.ext?.etag ?? 0) + 1 }))
    return false
  throw new Error(`extension drift: ${row.task}`)
}

/** Apply only manifest subjects, fail closed on errors; replay the SAME manifest. */
export async function applyBackfill(
  client: Client,
  input: unknown,
  target: string,
  expected: string
) {
  const manifest = validateManifest(input, target, expected)
  const progress: Progress = { written: 0, eventsCreated: 0, results: [] }
  try {
    // Catch stale plans before any write; recheck each row at its acting point.
    for (const row of manifest.rows) await checkRow(client, row)
    for (const row of manifest.rows) {
      const put = await checkRow(client, row)
      if (put) {
        const result = await client.wrkq.ext.put({
          subject: { task: row.task },
          ...KEY,
          body: { rev: row.targetRev },
          ifMatch: row.ext?.etag ?? 0,
          principalRef: BACKFILL_PRINCIPAL,
        })
        if (
          revision(result.ext.body) !== row.targetRev ||
          result.ext.etag !== (row.ext?.etag ?? 0) + 1
        ) {
          throw new Error(`unexpected put result: ${row.task}`)
        }
        progress.written++
      }
      const event = await client.wrkq.projectEvent.post({
        task: row.task,
        type: 'ext.backfill',
        summary: `Backfill ${row.task} acp/request/main`,
        // Wire spelling follows owner lowercase-key grammar (M5 erratum).
        // Deterministic ORIGINAL plan attributes survive partial failures/replay.
        attributes: {
          meta_rev: String(row.metaRev),
          ext_rev: row.ext === null ? 'null' : String(row.ext.rev),
          written: String(row.write),
        },
        idempotencyKey: `backfill:${row.task}:acp/request`,
        principalRef: BACKFILL_PRINCIPAL,
      })
      if (event.created) progress.eventsCreated++
      progress.results.push({ task: row.task, put, event: event.uuid, eventCreated: event.created })
    }
    return { sha256: manifest.sha256, visited: manifest.rows.length, ...progress }
  } catch (cause) {
    throw new BackfillFailure(
      'backfill stopped; inspect owner, then reconcile the same manifest',
      progress,
      cause
    )
  }
}

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
