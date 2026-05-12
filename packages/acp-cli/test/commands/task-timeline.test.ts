import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { makeTimelineFixture } from '../../src/__tests__/timeline-fixture.js'
import { runTaskTimelineCommand } from '../../src/commands/task-timeline.js'
import type { AcpClient, GetTaskResponse } from '../../src/http-client.js'
import { runCli } from '../cli-test-helpers.js'

const tempDirs: string[] = []

function makeHrcStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-task-timeline-command-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
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
  db.prepare(
    'INSERT INTO events (seq, ts, scope_ref, lane_ref, run_id, event_kind, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    42,
    '2026-05-11T05:31:34.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'tool_execution_start',
    '{"toolName":"exec_command","input":{"cmd":"ls -la /tmp"}}'
  )
  db.prepare(
    'INSERT INTO events (seq, ts, scope_ref, lane_ref, run_id, event_kind, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    43,
    '2026-05-11T05:29:57.000Z',
    'agent:cody:project:agent-spaces',
    'main',
    'cody-main',
    'codex.user_prompt',
    '{"prompt":"attach evidence for the workflow"}'
  )
  db.close()
  return path
}

function makeRunlessTimelineFixture(): GetTaskResponse {
  const response = makeTimelineFixture()
  return {
    ...response,
    events: response.events.filter((event) => !event.type.startsWith('participant_run.')),
    participantRuns: [],
    workflowHrcRunMaps: [],
  }
}

function createClientDouble(overrides: Partial<AcpClient>): AcpClient {
  return {
    createTask: overrides.createTask ?? (() => Promise.reject(new Error('not implemented'))),
    promoteTask: overrides.promoteTask ?? (() => Promise.reject(new Error('not implemented'))),
    getTask: overrides.getTask ?? (() => Promise.reject(new Error('not implemented'))),
    addEvidence: overrides.addEvidence ?? (() => Promise.reject(new Error('not implemented'))),
    transitionTask:
      overrides.transitionTask ?? (() => Promise.reject(new Error('not implemented'))),
    listTransitions:
      overrides.listTransitions ?? (() => Promise.reject(new Error('not implemented'))),
    listInterfaceBindings:
      overrides.listInterfaceBindings ?? (() => Promise.reject(new Error('not implemented'))),
    upsertInterfaceBinding:
      overrides.upsertInterfaceBinding ?? (() => Promise.reject(new Error('not implemented'))),
  }
}

describe('acp task timeline command', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('renders a plain task timeline from task show projection', async () => {
    const output = await runTaskTimelineCommand(['--task', 'T-TIMELINE', '--plain', '--no-hrc'], {
      createClient: () =>
        createClientDouble({
          async getTask(input) {
            expect(input).toEqual({ taskId: 'T-TIMELINE' })
            return makeTimelineFixture()
          },
        }),
    })

    expect(output).toMatchObject({ format: 'text' })
    expect(output.text).toContain('Task T-TIMELINE')
    expect(output.text).toContain('transition.rejected red_to_green')
    expect(output.text).toContain('hrc_run.mapped hrc-run-1')
  })

  test('supports json and rejection filtering', async () => {
    const output = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--rejections-only', '--json', '--no-hrc'],
      {
        createClient: () =>
          createClientDouble({
            async getTask() {
              return makeTimelineFixture()
            },
          }),
      }
    )

    expect(output.format).toBe('json')
    expect(output.body).toMatchObject({
      summary: { eventCount: 1, rejectionCount: 1 },
      rows: [expect.objectContaining({ rejectionCode: 'version_conflict' })],
    })
  })

  test('joins HRC rows by default and suppresses them with --no-hrc', async () => {
    const hrcStore = makeHrcStore()
    const deps = {
      createClient: () =>
        createClientDouble({
          async getTask() {
            return makeTimelineFixture()
          },
        }),
    }
    const joined = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--plain', '--hrc-store', hrcStore],
      deps
    )
    const acpOnly = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--plain', '--no-hrc', '--hrc-store', hrcStore],
      deps
    )

    expect(joined.text).toContain('hrc/42')
    expect(joined.text).toContain('💻 exec_command: ls -la /tmp')
    expect(acpOnly.text).not.toContain('hrc/42')
  })

  test('warns and renders ACP-only output when HRC store is unavailable', async () => {
    const output = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--plain', '--hrc-store', '/tmp/missing-hrc-store.sqlite'],
      {
        createClient: () =>
          createClientDouble({
            async getTask() {
              return makeTimelineFixture()
            },
          }),
      }
    )

    expect(output.text).toContain('WARNING HRC store at /tmp/missing-hrc-store.sqlite')
    expect(output.text).toContain('participant_run.launched prun_1')
    expect(output.text).not.toContain('hrc/')
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

  test('auto anchor joins actor event windows for runless tasks', async () => {
    const hrcStore = makeHrcStore()
    const output = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--plain', '--hrc-store', hrcStore],
      {
        createClient: () =>
          createClientDouble({
            async getTask() {
              return makeRunlessTimelineFixture()
            },
          }),
      }
    )

    expect(output.text).toContain('hrc/43')
    expect(output.text).toContain('💬 codex.user_prompt')
  })

  test('runs anchor keeps runless tasks ACP-only', async () => {
    const hrcStore = makeHrcStore()
    const output = await runTaskTimelineCommand(
      ['--task', 'T-TIMELINE', '--plain', '--hrc-store', hrcStore, '--hrc-anchor', 'runs'],
      {
        createClient: () =>
          createClientDouble({
            async getTask() {
              return makeRunlessTimelineFixture()
            },
          }),
      }
    )

    expect(output.text).not.toContain('hrc/43')
  })
})
