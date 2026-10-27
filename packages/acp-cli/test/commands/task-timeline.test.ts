import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { makeTimelineFixture } from '../../src/__tests__/timeline-fixture.js'
import type { GetTaskResponse } from '../../src/http-client.js'
import { runCli } from '../cli-test-helpers.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-task-timeline-command-'))
  tempDirs.push(dir)
  return dir
}

// [seq, ts, scopeRef, runId, eventKind, eventJson]
type HrcRow = [number, string, string, string | null, string, string]

const RUN_SCOPE = 'cody@agent-spaces:T-TIMELINE'

/** HRC state.sqlite with the legacy `events` table and/or the canonical `hrc_events` table. */
function makeStore(tables: { legacy?: HrcRow[]; hrc?: HrcRow[] }): string {
  const path = join(makeTempDir(), 'state.sqlite')
  const db = new Database(path)
  if (tables.legacy !== undefined) {
    db.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
    `)
    const insert = db.prepare(
      'INSERT INTO events (seq, ts, scope_ref, lane_ref, run_id, event_kind, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const [seq, ts, scopeRef, runId, kind, json] of tables.legacy) {
      insert.run(seq, ts, scopeRef, 'main', runId, kind, json)
    }
  }
  if (tables.hrc !== undefined) {
    db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
    const insert = db.prepare(
      'INSERT INTO hrc_events (hrc_seq, ts, scope_ref, lane_ref, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const [seq, ts, scopeRef, runId, kind, json] of tables.hrc) {
      insert.run(seq, ts, scopeRef, 'main', runId, kind, json)
    }
  }
  db.close()
  return path
}

function makeHrcStore(): string {
  return makeStore({
    legacy: [
      [
        42,
        '2026-05-11T05:31:34.000Z',
        RUN_SCOPE,
        'hrc-run-1',
        'tool_execution_start',
        '{"toolName":"exec_command","input":{"cmd":"ls -la /tmp"}}',
      ],
      [
        43,
        '2026-05-11T05:29:57.000Z',
        'agent:cody:project:agent-spaces',
        'cody-main',
        'codex.user_prompt',
        '{"prompt":"attach evidence for the workflow"}',
      ],
    ],
  })
}

// Legacy rows bound to the fixture's HRC run (hrc-run-1), inside the run window.
const LEGACY_RUN_ROWS: HrcRow[] = [
  [1, '2026-05-11T05:31:33.000Z', RUN_SCOPE, 'hrc-run-1', 'codex.websocket_event', '{}'],
  [
    2,
    '2026-05-11T05:31:34.000Z',
    RUN_SCOPE,
    'hrc-run-1',
    'tool_execution_start',
    '{"toolName":"exec_command"}',
  ],
  [3, '2026-05-11T05:31:34.100Z', RUN_SCOPE, 'hrc-run-1', 'message_start', '{"messageId":"msg_1"}'],
  [
    4,
    '2026-05-11T05:31:34.200Z',
    RUN_SCOPE,
    'hrc-run-1',
    'message_update',
    '{"messageId":"msg_1","textDelta":"tok"}',
  ],
  [
    5,
    '2026-05-11T05:31:34.300Z',
    RUN_SCOPE,
    'hrc-run-1',
    'tool_execution_update',
    '{"toolName":"exec_command","textDelta":"stdout chunk"}',
  ],
  [
    6,
    '2026-05-11T05:31:35.000Z',
    RUN_SCOPE,
    'hrc-run-1',
    'tool_execution_end',
    '{"toolName":"exec_command","isError":false}',
  ],
]

const CANONICAL_RUN_ROWS: HrcRow[] = [
  [
    100,
    '2026-05-11T05:31:34.000Z',
    RUN_SCOPE,
    'hrc-run-1',
    'turn.message',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
  ],
  [
    101,
    '2026-05-11T05:31:35.000Z',
    RUN_SCOPE,
    'hrc-run-1',
    'turn.completed',
    '{"finalOutput":"done"}',
  ],
]

// Rows for actor-event windows (runless tasks) and the run_id-miss fallback.
const JOIN_ROWS: HrcRow[] = [
  [
    10,
    '2026-05-11T05:31:33.000Z',
    RUN_SCOPE,
    'synthetic-run-id',
    'tool_execution_start',
    '{"toolName":"exec_command"}',
  ],
  [
    11,
    '2026-05-11T05:31:34.000Z',
    RUN_SCOPE,
    'synthetic-run-id',
    'tool_execution_end',
    '{"toolName":"exec_command"}',
  ],
  [
    12,
    '2026-05-11T05:29:10.000Z',
    'agent:clod:project:agent-spaces',
    'clod-main-run',
    'codex.user_prompt',
    '{"prompt":"create the SoD task"}',
  ],
  [
    13,
    '2026-05-11T05:29:57.000Z',
    'agent:cody:project:agent-spaces',
    'cody-main-run',
    'notice',
    '{"level":"info","message":"evidence attached"}',
  ],
]

function makeRunlessTimelineFixture(): GetTaskResponse {
  const response = makeTimelineFixture()
  return {
    ...response,
    timeline: response.timeline.filter((event) => !event.type.startsWith('participant_run.')),
    runs: [],
  }
}

type TimelineRun = {
  exitCode: number
  stdout: string
  stderr: string
  requests: string[]
}

async function timeline(
  args: string[],
  response: GetTaskResponse = makeTimelineFixture()
): Promise<TimelineRun> {
  const requests: string[] = []
  const result = await runCli(
    ['--server', 'http://acp.test', 'task', 'timeline', '--task', 'T-TIMELINE', ...args],
    {
      fetchImpl: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }
  )
  return { ...result, requests }
}

type JsonRow = Record<string, unknown>

async function timelineJson(
  args: string[],
  response?: GetTaskResponse
): Promise<{ rows: JsonRow[]; warnings?: string[]; collapsedRuns?: unknown; summary: unknown }> {
  const result = await timeline(['--json', ...args], response)
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout)
}

function hrcRows(rows: JsonRow[]): JsonRow[] {
  return rows.filter((row) => row['ledger'] === 'hrc')
}

describe('acp task timeline command', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('plain output renders the task header, rejection marker and HRC mapping without ANSI escapes', async () => {
    const result = await timeline(['--plain', '--no-hrc', '--width', '100'])

    expect(result.exitCode).toBe(0)
    expect(result.requests).toEqual(['GET /v1/tasks/T-TIMELINE'])
    expect(result.stdout).toContain('Task T-TIMELINE')
    expect(result.stdout).toContain('[x]   3 05:30:23')
    expect(result.stdout).toContain('transition.rejected red_to_green')
    expect(result.stdout).toContain('version_conflict')
    expect(result.stdout).toContain('[*]   6 05:32:22')
    expect(result.stdout).toContain('hrc_run.mapped hrc-run-1')
    expect(result.stdout.includes(String.fromCharCode(27))).toBe(false)
  })

  test('--json projects workflow events into enriched rows and --rejections-only keeps only rejections', async () => {
    const all = await timelineJson(['--no-hrc'])

    expect(all.summary).toMatchObject({ eventCount: 6, rejectionCount: 1 })
    expect(all.rows.map((row) => [row['seq'], row['category'], row['kind'], row['type']])).toEqual([
      [1, 'meta', 'accepted', 'task.created'],
      [2, 'evidence', 'evidence', 'evidence.attached'],
      [3, 'transition', 'rejected', 'transition.rejected'],
      [4, 'transition', 'accepted', 'transition.applied'],
      [5, 'run', 'run', 'participant_run.launched'],
      [6, 'mapping', 'mapping', 'workflow_hrc_run.mapped'],
    ])
    expect(all.rows[2]).toMatchObject({ rejectionCode: 'version_conflict' })
    expect(all.rows[3]).toMatchObject({ versionDelta: { from: 0, to: 1 } })
    expect(all.rows[5]).toMatchObject({
      scopeRef: RUN_SCOPE,
      refs: expect.arrayContaining(['hrc-run-1', `scope:${RUN_SCOPE}`]),
    })

    const rejections = await timelineJson(['--rejections-only', '--no-hrc'])
    expect(rejections).toMatchObject({
      summary: { eventCount: 1, rejectionCount: 1 },
      rows: [expect.objectContaining({ rejectionCode: 'version_conflict' })],
    })
    expect(rejections.rows).toHaveLength(1)
  })

  test('--markdown renders a task heading and an event table', async () => {
    const result = await timeline(['--markdown', '--no-hrc', '--width', '100'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('## Task T-TIMELINE · code_defect_fastlane@1')
    expect(result.stdout).toContain('| seq | time | event | actor | notes |')
    expect(result.stdout).toContain('❌ transition.rejected red_to_green')
  })

  test('--no-hrc suppresses HRC rows even when an HRC store is given', async () => {
    const result = await timeline(['--plain', '--no-hrc', '--hrc-store', makeHrcStore()])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('participant_run.launched prun_1')
    expect(result.stdout).not.toContain('hrc/42')
  })

  test('unreachable HRC store warns and renders ACP-only output', async () => {
    const missing = join(makeTempDir(), 'missing-hrc-store.sqlite')
    const result = await timeline(['--plain', '--hrc-store', missing])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`WARNING HRC store at ${missing}`)
    expect(result.stdout).toContain('participant_run.launched prun_1')
    expect(result.stdout).not.toContain('hrc/')
  })

  test('is registered under acp task timeline with explicit flags', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'task',
        'timeline',
        '--task',
        'T-TIMELINE',
        '--only',
        'transitions,rejections',
        '--plain',
        '--no-hrc',
      ],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify(makeTimelineFixture()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('transition.rejected red_to_green')
    expect(result.stdout).toContain('transition.applied red->green')
    expect(result.stdout).not.toContain('evidence.attached')
  })

  test('registered command keeps HRC join enabled by default', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'task',
        'timeline',
        '--task',
        'T-TIMELINE',
        '--plain',
        '--hrc-store',
        makeHrcStore(),
      ],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify(makeTimelineFixture()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hrc/42')
  })

  test('auto anchor joins HRC rows directly after the actor events of a runless task', async () => {
    const store = makeStore({ legacy: JOIN_ROWS })
    const { rows } = await timelineJson(['--hrc-store', store], makeRunlessTimelineFixture())

    const createdIndex = rows.findIndex(
      (row) => row['ledger'] === 'acp' && row['type'] === 'task.created'
    )
    const evidenceIndex = rows.findIndex(
      (row) => row['ledger'] === 'acp' && row['type'] === 'evidence.attached'
    )
    expect(rows[createdIndex + 1]).toMatchObject({
      ledger: 'hrc',
      parentParticipantRunId: 'event:1',
      hrcSeq: 12,
      eventKind: 'codex.user_prompt',
      joinKind: 'event_window',
      displayText: '💬 codex.user_prompt  "create the SoD task"',
    })
    expect(rows[evidenceIndex + 1]).toMatchObject({
      ledger: 'hrc',
      parentParticipantRunId: 'event:2',
      hrcSeq: 13,
      eventKind: 'notice',
      joinKind: 'event_window',
    })

    const plain = await timeline(['--plain', '--hrc-store', store], makeRunlessTimelineFixture())
    expect(plain.stdout).toContain('hrc/12')
    expect(plain.stdout).toContain('💬 codex.user_prompt  "create the SoD task"')
  })

  test('runs anchor keeps runless tasks ACP-only', async () => {
    const store = makeStore({ legacy: JOIN_ROWS })
    const { rows } = await timelineJson(
      ['--hrc-store', store, '--hrc-anchor', 'runs'],
      makeRunlessTimelineFixture()
    )

    expect(rows.length).toBeGreaterThan(0)
    expect(hrcRows(rows)).toEqual([])
  })

  test('run_id miss falls back to the delivery scope window, warns, and interleaves HRC rows under the run', async () => {
    const { rows, warnings } = await timelineJson(['--hrc-store', makeStore({ legacy: JOIN_ROWS })])

    const runIndex = rows.findIndex(
      (row) => row['ledger'] === 'acp' && row['type'] === 'participant_run.launched'
    )
    expect(warnings).toContain('hrc_join_fallback:prun_1:scope+window')
    expect(rows.slice(runIndex, runIndex + 3)).toEqual([
      expect.objectContaining({ ledger: 'acp', type: 'participant_run.launched' }),
      expect.objectContaining({
        ledger: 'hrc',
        hrcSeq: 10,
        eventKind: 'tool_execution_start',
        joinKind: 'scope_window',
      }),
      expect.objectContaining({
        ledger: 'hrc',
        hrcSeq: 11,
        eventKind: 'tool_execution_end',
        joinKind: 'scope_window',
      }),
    ])
  })

  test('--hrc-detail summary replaces a run block with one summary row carrying the total', async () => {
    const { rows } = await timelineJson([
      '--hrc-store',
      makeStore({ legacy: JOIN_ROWS }),
      '--hrc-detail',
      'summary',
    ])

    expect(hrcRows(rows)).toEqual([
      expect.objectContaining({
        ledger: 'hrc',
        parentParticipantRunId: 'prun_1',
        eventKind: 'hrc.summary',
        summary: expect.objectContaining({ totalCount: 2 }),
      }),
    ])
  })

  test('more than three consecutive calls to one tool collapse into a "… N more" line', async () => {
    const execStarts: HrcRow[] = ['pwd', 'ls', 'date', 'whoami', 'id'].map((cmd, index) => [
      20 + index,
      `2026-05-11T05:31:3${4 + index}.000Z`,
      RUN_SCOPE,
      'hrc-run-1',
      'tool_execution_start',
      JSON.stringify({ toolName: 'exec_command', input: { cmd } }),
    ])
    const store = makeStore({
      legacy: [
        ...execStarts,
        [
          30,
          '2026-05-11T05:31:40.000Z',
          RUN_SCOPE,
          'hrc-run-1',
          'tool_execution_start',
          '{"toolName":"apply_patch"}',
        ],
      ],
    })

    const json = await timelineJson(['--hrc-store', store])
    expect(json.collapsedRuns).toEqual([
      expect.objectContaining({
        parentParticipantRunId: 'prun_1',
        count: 2,
        toolName: 'exec_command',
      }),
    ])

    const plain = await timeline(['--plain', '--width', '100', '--hrc-store', store])
    expect(plain.stdout).toContain('💻 exec_command: pwd')
    expect(plain.stdout).toContain('💻 exec_command: date')
    expect(plain.stdout).not.toContain('💻 exec_command: whoami')
    expect(plain.stdout).toContain('… 2 more exec_command call')
    expect(plain.stdout).toContain('apply_patch')
  })

  test.each([
    {
      name: 'tool start shows the shared tool rendering with its command',
      kind: 'tool_execution_start',
      json: { toolName: 'exec_command', input: { cmd: 'ls -la /tmp' } },
      displayText: '💻 exec_command: ls -la /tmp',
    },
    {
      name: 'tool end shows the exit code from result metadata',
      kind: 'tool_execution_end',
      json: { toolName: 'exec_command', result: { metadata: { exit_code: 0 } } },
      displayText: '💻 exec_command: exit=0',
    },
    {
      name: 'codex apply_patch end reads the exit code from result content text',
      kind: 'tool_execution_end',
      json: {
        toolName: 'apply_patch',
        result: {
          content: [
            {
              type: 'text',
              text: '{"output":"Success. Updated the following files:\\nM packages/acp-cli/src/cli.ts\\n","metadata":{"exit_code":0,"duration_seconds":0}}',
            },
          ],
        },
        isError: false,
      },
      displayText: '🔧 apply_patch: exit=0',
    },
    {
      name: 'codex user prompt quotes the top-level prompt',
      kind: 'codex.user_prompt',
      json: {
        type: 'codex.user_prompt',
        prompt: 'You are starting an ACP workflow participant run.',
      },
      displayText: '💬 codex.user_prompt  "You are starting an ACP workflow participant run."',
    },
    {
      name: 'turn user prompt quotes nested message content',
      kind: 'turn.user_prompt',
      json: {
        type: 'message_end',
        message: {
          role: 'user',
          content: 'Use the context below as the authoritative task contract.',
        },
      },
      displayText:
        '💬 turn.user_prompt  "Use the context below as the authoritative task contract."',
    },
  ])('HRC row: $name', async ({ kind, json, displayText }) => {
    const store = makeStore({
      legacy: [
        [50, '2026-05-11T05:31:34.000Z', RUN_SCOPE, 'hrc-run-1', kind, JSON.stringify(json)],
      ],
    })

    const plain = await timeline(['--plain', '--width', '200', '--hrc-store', store])
    expect(plain.exitCode).toBe(0)
    expect(plain.stdout).toContain(displayText)
  })

  test('assistant message_end renders its body as a quoted markdown block', async () => {
    const store = makeStore({
      legacy: [
        [
          60,
          '2026-05-11T05:31:34.000Z',
          RUN_SCOPE,
          'hrc-run-1',
          'message_end',
          JSON.stringify({ message: { content: '## Done\n- first\n- second' } }),
        ],
      ],
    })

    const plain = await timeline(['--plain', '--width', '100', '--hrc-store', store])
    expect(plain.stdout).toContain('🤖 assistant')
    expect(plain.stdout).toContain('      > ## Done')
    expect(plain.stdout).toContain('      > • first')
  })

  test.each([
    {
      name: 'mixed store prefers canonical hrc_events over legacy events',
      tables: { legacy: LEGACY_RUN_ROWS, hrc: CANONICAL_RUN_ROWS },
      args: [] as string[],
      expected: [
        [100, 'turn.message'],
        [101, 'turn.completed'],
      ],
    },
    {
      name: 'canonical-only store reads hrc_events',
      tables: { hrc: CANONICAL_RUN_ROWS },
      args: [] as string[],
      expected: [
        [100, 'turn.message'],
        [101, 'turn.completed'],
      ],
    },
    {
      name: 'legacy store excludes transport noise and streaming deltas by default',
      tables: { legacy: LEGACY_RUN_ROWS },
      args: [] as string[],
      expected: [
        [2, 'tool_execution_start'],
        [6, 'tool_execution_end'],
      ],
    },
    {
      name: 'legacy store returns streaming deltas when --hrc-kinds names them',
      tables: { legacy: LEGACY_RUN_ROWS },
      args: ['--hrc-kinds', 'message_update,tool_execution_update'],
      expected: [
        [4, 'message_update'],
        [5, 'tool_execution_update'],
      ],
    },
    {
      name: 'legacy store returns every kind with --hrc-all-kinds',
      tables: { legacy: LEGACY_RUN_ROWS },
      args: ['--hrc-all-kinds'],
      expected: [
        [1, 'codex.websocket_event'],
        [2, 'tool_execution_start'],
        [3, 'message_start'],
        [4, 'message_update'],
        [5, 'tool_execution_update'],
        [6, 'tool_execution_end'],
      ],
    },
    {
      name: 'legacy store applies a wildcard --hrc-kinds filter',
      tables: { legacy: LEGACY_RUN_ROWS },
      args: ['--hrc-kinds', 'tool_execution_*'],
      expected: [
        [2, 'tool_execution_start'],
        [5, 'tool_execution_update'],
        [6, 'tool_execution_end'],
      ],
    },
  ])('HRC store: $name, joined by the run externalRunRef', async ({ tables, args, expected }) => {
    const { rows } = await timelineJson(['--hrc-store', makeStore(tables), ...args])
    const joined = hrcRows(rows)

    expect(joined.map((row) => [row['hrcSeq'], row['eventKind']])).toEqual(expected)
    for (const row of joined) {
      expect(row).toMatchObject({ parentParticipantRunId: 'prun_1', joinKind: 'run_id' })
      expect(row['marker']).toBeUndefined()
    }
  })

  test('--hrc-kinds filters actor-event window rows for runless tasks', async () => {
    const cody = 'agent:cody:project:agent-spaces'
    const store = makeStore({
      legacy: [
        [
          70,
          '2026-05-11T05:29:56.000Z',
          cody,
          'cody-main',
          'tool_execution_start',
          '{"toolName":"exec_command"}',
        ],
        [
          71,
          '2026-05-11T05:29:57.000Z',
          cody,
          'cody-main',
          'tool_execution_end',
          '{"toolName":"exec_command"}',
        ],
      ],
    })

    const { rows } = await timelineJson(
      ['--hrc-store', store, '--hrc-kinds', 'tool_execution_end'],
      makeRunlessTimelineFixture()
    )

    expect(
      hrcRows(rows)
        .filter((row) => row['marker'] === undefined)
        .map((row) => [row['hrcSeq'], row['eventKind'], row['joinKind']])
    ).toEqual([[71, 'tool_execution_end', 'event_window']])
  })
})
