/**
 * E2E: GET /v1/wrkq/projects/:project/timeline against the real wrkq (T-10765).
 *
 * Opt-in: `ACP_WRKQ_TIMELINE_E2E=1` with `WRKQ_DB` pointing at the real wrkq.
 * By default the test boots createAcpServer behind a real Bun HTTP listener,
 * wired to ACP's own WorkClient lifecycle. `ACP_WRKQ_TIMELINE_E2E_BASE_URL`
 * (for example `http://127.0.0.1:18470`) points it at a running acp-server
 * instead. `ACP_WRKQ_TIMELINE_E2E_ARTIFACT` names a JSON file the run writes
 * its observed evidence to.
 *
 * Step 3 posts one real `guard.probe` fact to the project through `wrkp post`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import type { WrkqContainerTimelineView, WrkqTimelineEntry } from '@wrkq/client'

import { createWrkfClientLifecycle } from '../src/wrkf/client-lifecycle.js'
import type { WrkfLifecycle } from '../src/wrkf/client-lifecycle.js'

import { withWiredServer } from './fixtures/wired-server.js'

const ENABLED = process.env['ACP_WRKQ_TIMELINE_E2E'] === '1'
const PROJECT = process.env['ACP_WRKQ_TIMELINE_E2E_PROJECT'] ?? 'hrc-ios'
const SOURCE_TASK = 'T-10765'

const evidence: Record<string, unknown> = { project: PROJECT }
let baseUrl = process.env['ACP_WRKQ_TIMELINE_E2E_BASE_URL'] ?? ''
let lifecycle: WrkfLifecycle | undefined
let stopServer: (() => void) | undefined

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } }

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/v1/wrkq/projects/${encodeURIComponent(PROJECT)}${path}`)
  return { status: response.status, body: await response.json() }
}

async function getTimeline(query: string): Promise<WrkqContainerTimelineView> {
  const { status, body } = await get(`/timeline${query}`)
  expect({ query, status }).toEqual({ query, status: 200 })
  return body as WrkqContainerTimelineView
}

function wrkp(args: string[]): string {
  const result = Bun.spawnSync(['wrkp', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`wrkp ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

function projectEventType(entry: WrkqTimelineEntry): string | undefined {
  return entry.type === 'project.event' ? entry.projectEvent.type : undefined
}

function entryIdentity(entry: Record<string, unknown>): string {
  const projectEvent = entry['projectEvent'] as { uuid?: string } | undefined
  return projectEvent?.uuid !== undefined
    ? `pe:${projectEvent.uuid}`
    : `${String(entry['type'])}:${String(entry['eventId'])}:${String(entry['timestamp'])}`
}

describe.skipIf(!ENABLED)('GET /v1/wrkq/projects/:project/timeline (real wrkq)', () => {
  beforeAll(async () => {
    if (baseUrl !== '') return
    lifecycle = await createWrkfClientLifecycle({
      principalRef: 'agent:acp-server',
      dbLocator: process.env['WRKQ_DB'],
      clientInfo: { name: 'acp-server-e2e', version: '0' },
    })
    const workClient = lifecycle.client
    if (workClient === undefined) throw new Error('wrkq client did not start')
    // Hold the wired server open for the whole suite; release it in afterAll.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      void withWiredServer(
        async ({ handler }) => {
          const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => handler(r) })
          baseUrl = `http://127.0.0.1:${server.port}`
          stopServer = () => {
            server.stop(true)
            release()
          }
          resolve()
          await held
        },
        { workClient }
      )
    })
    await ready
  })

  afterAll(async () => {
    stopServer?.()
    await lifecycle?.close()
    evidence['baseUrl'] = baseUrl
    const artifact = process.env['ACP_WRKQ_TIMELINE_E2E_ARTIFACT']
    if (artifact !== undefined) writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`)
  })

  test('1+5: limit=5 is newest-first, hides turn.*, and matches wrkp log entry keys', async () => {
    const cliEntries = JSON.parse(wrkp(['log', PROJECT, '--limit', '5', '--json'])) as Record<
      string,
      unknown
    >[]
    const view = await getTimeline('?limit=5')

    expect(view.entries).toHaveLength(5)
    expect(typeof view.nextCursor).toBe('string')
    expect(typeof view.snapshotEventId).toBe('number')
    expect(view.container).toBeDefined()
    const timestamps = view.entries.map((entry) => entry.timestamp)
    expect(timestamps).toEqual([...timestamps].sort().reverse())
    expect(view.entries.filter((entry) => projectEventType(entry)?.startsWith('turn.'))).toEqual([])

    const routeById = new Map(
      (view.entries as unknown as Record<string, unknown>[]).map((entry) => [
        entryIdentity(entry),
        entry,
      ])
    )
    const matched = cliEntries.filter((entry) => routeById.has(entryIdentity(entry)))
    // A busy project can advance between the two reads; most of the window overlaps.
    expect(matched.length).toBeGreaterThanOrEqual(3)
    for (const cliEntry of matched) {
      const routeEntry = routeById.get(entryIdentity(cliEntry)) as Record<string, unknown>
      expect(Object.keys(routeEntry).sort()).toEqual(Object.keys(cliEntry).sort())
    }
    evidence['limit5'] = {
      entries: view.entries.map((entry) => ({
        type: entry.type,
        projectEventType: projectEventType(entry),
        timestamp: entry.timestamp,
      })),
      nextCursor: view.nextCursor,
      keyMatchedEntries: matched.length,
    }
  })

  test('2: allTypes=true surfaces turn.*', async () => {
    let found: WrkqTimelineEntry | undefined
    for (const query of ['?allTypes=true&limit=50', '?allTypes=true&limit=500&since=24h']) {
      const view = await getTimeline(query)
      found = view.entries.find((entry) => projectEventType(entry)?.startsWith('turn.'))
      if (found !== undefined) break
    }
    expect(found).toBeDefined()
    evidence['allTypesTurnEntry'] = found !== undefined ? projectEventType(found) : null
  })

  test('3: tail cursor reads exactly the appended fact, with no order sent', async () => {
    const tail = await getTimeline('?tail=true&types=guard.probe')
    expect(tail.entries).toEqual([])
    expect(typeof tail.nextCursor).toBe('string')
    const forward = tail.nextCursor as string

    const marker = randomUUID()
    wrkp([
      'post',
      PROJECT,
      '--type',
      'guard.probe',
      '-m',
      marker,
      '--attr',
      `source=${SOURCE_TASK}`,
    ])

    // A forward read is cursor + tail, exactly what `wrkp log --after` sends; a
    // cursor alone pages inside the snapshot it was minted at.
    const view = await getTimeline(
      `?tail=true&cursor=${encodeURIComponent(forward)}&types=guard.probe`
    )
    expect(view.entries).toHaveLength(1)
    const entry = view.entries[0] as WrkqTimelineEntry
    expect(entry.type).toBe('project.event')
    if (entry.type !== 'project.event') return
    expect(entry.projectEvent.type).toBe('guard.probe')
    expect(entry.projectEvent.summary).toBe(marker)
    expect(entry.projectEvent.attributes['source']).toBe(SOURCE_TASK)
    evidence['forwardCursor'] = { forward, marker, entry }
  })

  test('4: bad query is 400 with field; unknown project is 404', async () => {
    const rejected: Record<string, unknown> = {}
    for (const [query, field] of [
      ['?limit=0', 'limit'],
      ['?limit=501', 'limit'],
      ['?order=up', 'order'],
      ['?tail=yes', 'tail'],
      ['?allTypes=1', 'allTypes'],
      ['?types=,', 'types'],
    ] as const) {
      const { status, body } = await get(`/timeline${query}`)
      expect({ query, status, field: (body as ErrorBody).error.details?.['field'] }).toEqual({
        query,
        status: 400,
        field,
      })
      rejected[query] = body
    }

    const response = await fetch(`${baseUrl}/v1/wrkq/projects/no-such-project-t10765/timeline`)
    expect(response.status).toBe(404)
    const body = (await response.json()) as ErrorBody
    expect(body.error.code).toBe('WRKQ_NOT_FOUND')
    rejected['unknownProject'] = body
    evidence['rejected'] = rejected
  })
})
