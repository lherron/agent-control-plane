/**
 * RED TESTS — W2b: acp-cli consumers migrated off removed workflow authority fields
 *
 * Why red now:
 *   1. GetTaskResponse in http-client.ts still declares participantRuns/supervisorRuns/
 *      workflowHrcRunMaps and does NOT declare runs or source.
 *   2. task-transition reads taskSnapshot.task.version (undefined in wrkf response) instead
 *      of taskSnapshot.instance.revision.
 *   3. task-evidence-add --from-run reads taskSnapshot.participantRuns (undefined in wrkf
 *      response) instead of taskSnapshot.runs, and looks up by runId rather than id.
 *   4. joinHrcTimeline reads response.workflowHrcRunMaps (absent in wrkf response) instead
 *      of deriving HRC run mappings from response.runs[i].externalRunRef.
 *
 * What the impl agent must change to make these green:
 *
 * FILE: packages/acp-cli/src/http-client.ts
 *   - Remove supervisorRuns, participantRuns, workflowHrcRunMaps, anomalies,
 *     workflowPatchProposals, events fields from GetTaskResponse.
 *   - Add a WrkfRun type:
 *       export type WrkfRun = {
 *         id: string; role: string; actor: string; status: string;
 *         externalRunRef?: string; deliveryRef?: string;
 *         startedAt: string; completedAt?: string; terminalResult?: string
 *       }
 *   - Update GetTaskResponse to match the new wrkf projection:
 *       source: string
 *       task: unknown               (wrkf task, not WorkflowTask from acp-core)
 *       instance: { revision: number; [key: string]: unknown }
 *       next: unknown
 *       timeline: unknown[]
 *       evidence: unknown[]
 *       obligations: unknown[]
 *       effects: unknown[]
 *       runs: WrkfRun[]
 *   - Remove the WorkflowHrcRunMap import (no longer needed in GetTaskResponse).
 *
 * FILE: packages/acp-cli/src/commands/task-transition.ts
 *   - When --expected-version is omitted, read instance.revision instead of task.version:
 *       const taskSnapshot = await requester.requestJson<{
 *         instance: { revision: number }
 *       }>({ method: 'GET', path: `/v1/tasks/${...}` })
 *       expectedTaskVersion = taskSnapshot.instance.revision
 *
 * FILE: packages/acp-cli/src/commands/task-evidence-add.ts
 *   - --from-run: look up via taskSnapshot.runs.find(r => r.id === fromRun) (not participantRuns)
 *   - Use run.id as runId (not run.runId):
 *       const taskSnapshot = await requester.requestJson<{
 *         runs: Array<{ id: string; role: string }>
 *       }>({ method: 'GET', ... })
 *       const run = taskSnapshot.runs.find(r => r.id === fromRun)
 *       if (run !== undefined) {
 *         role = role ?? run.role
 *         runId = runId ?? run.id
 *         participantRunId = participantRunId ?? run.id
 *       }
 *
 * FILE: packages/acp-cli/src/output/timeline-hrc-join.ts
 *   - Replace `const maps = options.response.workflowHrcRunMaps ?? []` with run-derived maps.
 *   - Define a local helper that builds WorkflowHrcRunMap-shaped objects from response.runs:
 *       function runDerivedMaps(response: GetTaskResponse): WorkflowHrcRunMap[] {
 *         const runs = (response.runs as WrkfRun[] | undefined) ?? []
 *         return runs
 *           .filter(r => r.externalRunRef !== undefined && r.externalRunRef.length > 0)
 *           .map(r => {
 *             const delivery = tryParseDeliveryRef(r.deliveryRef)
 *             return {
 *               mapId: r.id,
 *               workflowTaskId: '',
 *               participantRunId: r.id,
 *               hrcRunId: r.externalRunRef!,
 *               scopeRef: delivery?.scopeRef,
 *               laneRef: delivery?.laneRef,
 *               createdAt: r.startedAt,
 *               source: 'wrkf',
 *             }
 *           })
 *       }
 *       function tryParseDeliveryRef(ref: string | undefined): { scopeRef?: string; laneRef?: string } | undefined {
 *         if (ref === undefined || ref.length === 0) return undefined
 *         try { return JSON.parse(ref) } catch { return undefined }
 *       }
 *   - Replace `response.workflowHrcRunMaps ?? []` with `runDerivedMaps(response)`.
 *   - In `participantCompleteTs`, update the run lookup to use run.id instead of run.runId:
 *       const typedRuns = (response.runs as Array<{ id?: string; completedAt?: string }> | undefined) ?? []
 *       return typedRuns.find(run => run.id === runId)?.completedAt
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { HrcStoreReader } from '../hrc-store-reader.js'
import type { GetTaskResponse } from '../http-client.js'
import { joinHrcTimeline } from '../output/timeline-hrc-join.js'
import { runTaskEvidenceAddCommand } from '../commands/task-evidence-add.js'
import { runTaskTransitionCommand } from '../commands/task-transition.js'

// ── Wrkf response shape (what the server returns after W2a) ──────────────────

type WrkfRun = {
  id: string
  role: string
  actor: string
  status: string
  externalRunRef?: string | undefined
  deliveryRef?: string | undefined
  startedAt: string
  completedAt?: string | undefined
}

function makeWrkfTaskResponse(taskId: string, opts: {
  instanceRevision?: number
  runs?: WrkfRun[]
} = {}): Record<string, unknown> {
  return {
    source: 'wrkf',
    task: { taskId, projectId: 'P-001', status: 'open' },
    instance: {
      id: `I-${taskId}`,
      taskRef: taskId,
      revision: opts.instanceRevision ?? 1,
      contextHash: 'sha256:ctx',
      status: 'open',
      templateId: 'basic',
      templateVersion: '1',
      templateHash: 'sha256:tmpl',
      createdAt: '2026-06-05T00:00:00Z',
      updatedAt: '2026-06-05T00:00:00Z',
    },
    next: { transitions: [] },
    timeline: [],
    evidence: [],
    obligations: [],
    effects: [],
    runs: opts.runs ?? [],
  }
}

// ── HRC store fixture for timeline join tests ─────────────────────────────────

const tempDirs: string[] = []

function makeHrcStore(hrcRunId: string, scopeRef: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-w2b-hrc-'))
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
    100,
    '2026-06-05T10:00:00.000Z',
    scopeRef,
    'main',
    hrcRunId,
    'tool_execution_start',
    '{"toolName":"bash_tool","input":{"cmd":"echo hello"}}'
  )
  db.prepare(
    'INSERT INTO events (seq, ts, scope_ref, lane_ref, run_id, event_kind, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    101,
    '2026-06-05T10:00:01.000Z',
    scopeRef,
    'main',
    hrcRunId,
    'tool_execution_end',
    '{"toolName":"bash_tool","output":{"stdout":"hello"}}'
  )
  db.close()
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Consumer 1: GetTaskResponse type declarations ────────────────────────────
//
// RED because: http-client.ts GetTaskResponse still has participantRuns, supervisorRuns,
//   workflowHrcRunMaps and does NOT have runs or source.
// GREEN when: those old fields are removed and runs/source are added.

describe('W2b Consumer 1: GetTaskResponse type must drop ACP-only fields and add wrkf runs', () => {
  const httpClientSrc = readFileSync(
    new URL('../http-client.ts', import.meta.url),
    'utf-8'
  )

  function getResponseTypeSrc(): string {
    const start = httpClientSrc.indexOf('export type GetTaskResponse = {')
    expect(start).toBeGreaterThan(-1) // type must still exist
    const end = httpClientSrc.indexOf('\n}', start) + 2
    return httpClientSrc.slice(start, end)
  }

  test('GetTaskResponse must not declare participantRuns (RED: still present)', () => {
    // RED: http-client.ts still has `participantRuns: unknown[]` in GetTaskResponse
    // GREEN: participantRuns is removed from the type
    expect(getResponseTypeSrc()).not.toContain('participantRuns')
  })

  test('GetTaskResponse must not declare supervisorRuns (RED: still present)', () => {
    // RED: http-client.ts still has `supervisorRuns: unknown[]` in GetTaskResponse
    // GREEN: supervisorRuns is removed from the type
    expect(getResponseTypeSrc()).not.toContain('supervisorRuns')
  })

  test('GetTaskResponse must not declare workflowHrcRunMaps (RED: still present)', () => {
    // RED: http-client.ts still has `workflowHrcRunMaps?: WorkflowHrcRunMap[]` in GetTaskResponse
    // GREEN: workflowHrcRunMaps is removed from the type
    expect(getResponseTypeSrc()).not.toContain('workflowHrcRunMaps')
  })

  test('GetTaskResponse must declare runs field (RED: field absent)', () => {
    // RED: http-client.ts GetTaskResponse does not have a `runs` field
    // GREEN: runs field is added (e.g. `runs: WrkfRun[]`)
    expect(getResponseTypeSrc()).toMatch(/\bruns[?:]/)
  })

  test('GetTaskResponse must declare source field (RED: field absent)', () => {
    // RED: http-client.ts GetTaskResponse does not have a `source` field
    // GREEN: source field is added (e.g. `source: string`)
    expect(getResponseTypeSrc()).toMatch(/\bsource[?:]/)
  })
})

// ── Consumer 2: task-transition without --expected-version ───────────────────
//
// RED because: task-transition.ts reads taskSnapshot.task.version (undefined in wrkf response).
//   The POST body gets expectedTaskVersion: undefined, so the `toMatchObject` assertion fails.
// GREEN when: code reads taskSnapshot.instance.revision instead.

describe('W2b Consumer 2: task-transition without --expected-version reads instance.revision', () => {
  test(
    'GET returns wrkf projection with instance.revision=11; POST must send expectedTaskVersion=11 (RED: reads task.version=undefined)',
    async () => {
      const seen: Array<{ url: string; method?: string; body: unknown }> = []

      await runTaskTransitionCommand(
        [
          '--server',
          'http://acp.test',
          '--actor',
          'cody',
          '--task',
          'T-W2b',
          '--transition',
          'start',
          '--role',
          'owner',
          '--idempotency-key',
          'w2b:revision:test',
          // NOTE: --expected-version intentionally omitted — CLI must read wrkf revision
        ],
        {
          fetchImpl: async (input, init) => {
            const url = String(input)
            const method = init?.method ?? 'GET'
            const body =
              init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
            seen.push({ url, method, body })

            if (method === 'GET') {
              // Return wrkf-shaped response: NO task.version, but instance.revision = 11
              return new Response(
                JSON.stringify(makeWrkfTaskResponse('T-W2b', { instanceRevision: 11 })),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
            }

            // POST /transitions
            return new Response(
              JSON.stringify({
                task: {
                  taskId: 'T-W2b',
                  state: { status: 'active', phase: 'in_progress' },
                  version: 12,
                },
                event: { payload: { transitionId: 'start' } },
                effects: [],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          },
        }
      )

      // Two requests: GET (fetch revision) + POST (transition)
      expect(seen.map((c) => c.method)).toEqual(['GET', 'POST'])

      // RED: task.version is undefined in wrkf response → POST sends expectedTaskVersion: undefined
      //   toMatchObject fails because undefined !== 11
      // GREEN: reads instance.revision = 11 → POST sends expectedTaskVersion: 11
      expect(seen[1]?.body).toMatchObject({ expectedTaskVersion: 11 })
    }
  )
})

// ── Consumer 3: task-evidence-add --from-run resolves via wrkf runs ───────────
//
// RED because: task-evidence-add.ts reads taskSnapshot.participantRuns (undefined in wrkf
//   response) → TypeError: Cannot read properties of undefined (reading 'find') → test throws.
// GREEN when: code reads taskSnapshot.runs[i].id instead of participantRuns[i].runId.

describe('W2b Consumer 3: task-evidence-add --from-run resolves via wrkf runs (not participantRuns)', () => {
  test(
    '--from-run finds run by id from wrkf runs projection (RED: reads participantRuns which is undefined → TypeError)',
    async () => {
      const seen: Array<{ url: string; method?: string; body: unknown }> = []

      // RED: will throw TypeError (participantRuns is undefined, .find() blows up)
      // GREEN: resolves role='implementer' and runId='run-wrkf-1' from wrkf runs
      await runTaskEvidenceAddCommand(
        [
          '--server',
          'http://acp.test',
          '--actor',
          'cody',
          '--task',
          'T-W2b',
          '--from-run',
          'run-wrkf-1',
          '--kind',
          'completion_note',
          '--ref',
          'artifact://done',
          '--idempotency-key',
          'w2b:evidence:from-run',
        ],
        {
          fetchImpl: async (input, init) => {
            const url = String(input)
            const method = init?.method ?? 'GET'
            const body =
              init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
            seen.push({ url, method, body })

            if (method === 'GET') {
              // Return wrkf-shaped response: runs array uses id (not runId), no participantRuns
              return new Response(
                JSON.stringify(
                  makeWrkfTaskResponse('T-W2b', {
                    runs: [
                      {
                        id: 'run-wrkf-1',
                        role: 'implementer',
                        actor: 'agent:cody',
                        status: 'active',
                        startedAt: '2026-06-05T09:00:00Z',
                      },
                    ],
                  })
                ),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
            }

            // POST /evidence
            return new Response(
              JSON.stringify({
                evidence: [
                  {
                    evidenceId: 'evd-w2b-1',
                    taskId: 'T-W2b',
                    kind: 'completion_note',
                    ref: 'artifact://done',
                  },
                ],
              }),
              { status: 201, headers: { 'content-type': 'application/json' } }
            )
          },
        }
      )

      // Two requests: GET (fetch runs for --from-run resolution) + POST (add evidence)
      expect(seen.map((c) => c.method)).toEqual(['GET', 'POST'])

      // RED: TypeError thrown before reaching these assertions (participantRuns is undefined)
      // GREEN: run found by id → role and runId resolved from wrkf run
      expect(seen[1]?.body).toMatchObject({
        role: 'implementer',
        runId: 'run-wrkf-1',
      })
    }
  )
})

// ── Consumer 4: timeline join via wrkf run.externalRunRef ────────────────────
//
// RED because: joinHrcTimeline reads response.workflowHrcRunMaps (absent → empty array []).
//   With no HRC maps, the join produces a `no_mapping` marker row instead of real HRC events.
// GREEN when: joinHrcTimeline reads response.runs[i].externalRunRef to derive the HRC mapping.

describe('W2b Consumer 4: joinHrcTimeline uses wrkf run.externalRunRef (not workflowHrcRunMaps)', () => {
  const WRKF_RUN_ID = 'wrkf-run-timeline-1'
  const HRC_RUN_ID = 'hrc-run-timeline-1'
  const SCOPE_REF = 'cody@agent-spaces:T-W2b'

  function makeWrkfGetTaskResponseForTimeline(): GetTaskResponse {
    // Build a GetTaskResponse shaped for the wrkf projection:
    // - No workflowHrcRunMaps
    // - No participantRuns
    // - Has runs with externalRunRef → HRC run ID
    // - Has timeline events (wrkf format) — empty for this test; we drive via ACP-format rows below
    return {
      source: 'wrkf',
      task: {
        taskId: 'T-W2b',
        projectId: 'agent-spaces',
        workflow: { id: 'basic', version: 1, hash: 'sha256:wf' },
        state: { status: 'active', phase: 'in_progress' },
        version: 1,
        goal: 'test wrkf timeline join',
        roleBindings: { implementer: { kind: 'agent', id: 'cody' } },
        createdAt: '2026-06-05T09:00:00Z',
        updatedAt: '2026-06-05T09:01:00Z',
      },
      // wrkf timeline (not used by joinHrcTimeline directly)
      timeline: [],
      evidence: [],
      obligations: [],
      effects: [],
      // wrkf runs — externalRunRef binds the wrkf run to the HRC run
      runs: [
        {
          id: WRKF_RUN_ID,
          role: 'implementer',
          actor: 'agent:cody',
          status: 'active',
          externalRunRef: HRC_RUN_ID,
          deliveryRef: JSON.stringify({ scopeRef: SCOPE_REF, laneRef: 'main' }),
          startedAt: '2026-06-05T09:01:00Z',
        },
      ],
    } as unknown as GetTaskResponse
  }

  function makeMinimalProjectionWithParticipantRun(): import('../output/timeline-project.js').TaskTimelineProjection {
    // A minimal projection containing a participant_run.launched row that joinHrcTimeline
    // uses as the anchor point for HRC event injection.
    return {
      task: {
        taskId: 'T-W2b',
        projectId: 'agent-spaces',
        workflow: { id: 'basic', version: 1, hash: 'sha256:wf' },
        state: { status: 'active', phase: 'in_progress' },
        version: 1,
        goal: 'test wrkf timeline join',
        roleBindings: { implementer: { kind: 'agent', id: 'cody' } },
        createdAt: '2026-06-05T09:00:00Z',
        updatedAt: '2026-06-05T09:01:00Z',
      },
      summary: { eventCount: 1, rejectionCount: 0, firstEventAt: '2026-06-05T09:01:00Z', lastEventAt: '2026-06-05T09:01:00Z' },
      rows: [
        {
          ledger: 'acp',
          seq: 1,
          ts: '2026-06-05T09:01:00Z',
          kind: 'accepted',
          category: 'run',
          type: 'participant_run.launched',
          actor: { kind: 'agent', id: 'cody' },
          role: 'implementer',
          participantRunId: WRKF_RUN_ID,
          refs: [WRKF_RUN_ID],
          payload: { runId: WRKF_RUN_ID, role: 'implementer' },
          eventHash: 'sha256:e1',
        },
      ],
    }
  }

  test(
    'joinHrcTimeline derives HRC mapping from runs[i].externalRunRef when workflowHrcRunMaps is absent (RED: maps is empty → no_mapping)',
    () => {
      const hrcStorePath = makeHrcStore(HRC_RUN_ID, SCOPE_REF)
      const reader = new HrcStoreReader(hrcStorePath)
      const response = makeWrkfGetTaskResponseForTimeline()
      const projection = makeMinimalProjectionWithParticipantRun()

      const result = joinHrcTimeline(projection, {
        reader,
        response,
        detail: 'events',
        anchorMode: 'runs',
      })
      reader.close()

      const hrcRows = result.rows.filter((row) => row.ledger === 'hrc')

      // RED: response.workflowHrcRunMaps is absent → maps = [] → no_mapping marker row
      //   hrcRows[0].marker === 'no_mapping' (not real HRC events)
      // GREEN: joinHrcTimeline reads response.runs[0].externalRunRef = HRC_RUN_ID,
      //   fetches events from HRC store by run ID, and produces real HRC event rows.
      expect(hrcRows.length).toBeGreaterThan(0)
      // Must contain actual HRC event rows (not just a no_mapping placeholder)
      expect(hrcRows).toContainEqual(
        expect.objectContaining({
          ledger: 'hrc',
          eventKind: 'tool_execution_start',
          joinKind: 'run_id',
        })
      )
      // Must NOT have a no_mapping marker (which is the current "red" behavior)
      expect(hrcRows).not.toContainEqual(
        expect.objectContaining({ marker: 'no_mapping' })
      )
    }
  )

  test(
    'timeline-hrc-join.ts must not read workflowHrcRunMaps from response (RED: line contains workflowHrcRunMaps)',
    () => {
      // Source-level assertion: joinHrcTimeline must not use response.workflowHrcRunMaps.
      // After migration it derives HRC mappings from response.runs[i].externalRunRef instead.
      // RED: timeline-hrc-join.ts still has `options.response.workflowHrcRunMaps ?? []`
      // GREEN: that line is removed/replaced with wrkf run-derived mapping logic
      const hrcJoinSrc = readFileSync(
        new URL('../output/timeline-hrc-join.ts', import.meta.url),
        'utf-8'
      )
      expect(hrcJoinSrc).not.toContain('workflowHrcRunMaps')
    }
  )

  test(
    'timeline-hrc-join.ts participantCompleteTs must not read response.participantRuns (RED: still reads participantRuns)',
    () => {
      // Source-level assertion: participantCompleteTs must read from response.runs (wrkf shape),
      // using run.id for the lookup (not run.runId from old ACP participantRuns shape).
      // RED: participantCompleteTs still accesses `response.participantRuns` via cast
      // GREEN: reads `response.runs` and looks up by run.id
      const hrcJoinSrc = readFileSync(
        new URL('../output/timeline-hrc-join.ts', import.meta.url),
        'utf-8'
      )
      const fnStart = hrcJoinSrc.indexOf('function participantCompleteTs')
      expect(fnStart).toBeGreaterThan(-1) // function must still exist
      const fnEnd = hrcJoinSrc.indexOf('\n}', fnStart) + 2
      const fnBody = hrcJoinSrc.slice(fnStart, fnEnd)
      expect(fnBody).not.toContain('participantRuns')
    }
  )
})
