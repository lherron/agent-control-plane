import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { WrkqTaskNotFoundError, openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

import BetterSqliteDatabase from 'better-sqlite3'

type TestDatabase = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
  }
  close(): unknown
}

function openTestDatabase(dbPath: string): TestDatabase {
  return (
    typeof Bun !== 'undefined' ? new BunDatabase(dbPath) : new BetterSqliteDatabase(dbPath)
  ) as TestDatabase
}

describe('TransitionLogRepo', () => {
  test('appends and lists transition records with actor metadata', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10401',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'red',
        riskClass: 'medium',
        roleMap: { implementer: 'larry' },
        version: 0,
      })

      store.transitionLogRepo.appendTransition('T-10401', {
        taskId: 'T-10401',
        transitionEventId: 'TR-90001',
        timestamp: '2026-04-19T12:05:00.000Z',
        from: { lifecycleState: 'active', phase: 'red' },
        to: { lifecycleState: 'active', phase: 'green' },
        actor: { agentId: 'larry', role: 'implementer', scopeRef: 'larry@agent-spaces' },
        requiredEvidenceKinds: ['tdd_green_bundle'],
        evidenceKinds: ['tdd_green_bundle'],
        waivedEvidenceKinds: [],
        expectedVersion: 0,
        nextVersion: 1,
      })

      expect(store.transitionLogRepo.listTransitions('T-10401')).toEqual([
        {
          taskId: 'T-10401',
          transitionEventId: 'TR-90001',
          timestamp: '2026-04-19T12:05:00.000Z',
          from: { lifecycleState: 'active', phase: 'red' },
          to: { lifecycleState: 'active', phase: 'green' },
          actor: { agentId: 'larry', role: 'implementer', scopeRef: 'larry@agent-spaces' },
          requiredEvidenceKinds: ['tdd_green_bundle'],
          evidenceKinds: ['tdd_green_bundle'],
          waivedEvidenceKinds: [],
          expectedVersion: 0,
          nextVersion: 1,
        },
      ])
    })
  })

  test('stores cited evidence UUIDs for matching evidence kinds', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10402',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'red',
        riskClass: 'medium',
        roleMap: { implementer: 'larry' },
        version: 0,
      })
      store.evidenceRepo.appendEvidence('T-10402', [
        { kind: 'tdd_green_bundle', ref: 'artifact://green/1' },
        {
          kind: 'waiver',
          ref: 'artifact://waiver/1',
          details: { waiverKind: 'qa_bundle', scope: 'green->verified' },
        },
      ])

      store.transitionLogRepo.appendTransition('T-10402', {
        taskId: 'T-10402',
        transitionEventId: 'TR-90002',
        timestamp: '2026-04-19T12:10:00.000Z',
        from: { lifecycleState: 'active', phase: 'green' },
        to: { lifecycleState: 'active', phase: 'verified' },
        actor: { agentId: 'curly', role: 'tester' },
        requiredEvidenceKinds: ['qa_bundle'],
        evidenceKinds: ['tdd_green_bundle'],
        waivedEvidenceKinds: ['qa_bundle'],
        expectedVersion: 1,
        nextVersion: 2,
      })

      const sqlite = openTestDatabase(fixture.dbPath)
      const row = sqlite
        .prepare('SELECT evidence_item_uuids FROM task_transitions WHERE id = ?')
        .get('TR-90002') as { evidence_item_uuids: string | null }
      sqlite.close()

      expect(row.evidence_item_uuids).not.toBeNull()
      expect(JSON.parse(row.evidence_item_uuids ?? '[]')).toHaveLength(2)
    })
  })

  test('lists transitions in timestamp order', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10403',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'open',
        riskClass: 'medium',
        roleMap: {},
        version: 0,
      })
      store.transitionLogRepo.appendTransition('T-10403', {
        taskId: 'T-10403',
        transitionEventId: 'TR-90003',
        timestamp: '2026-04-19T12:01:00.000Z',
        from: { lifecycleState: 'active', phase: 'open' },
        to: { lifecycleState: 'active', phase: 'red' },
        actor: { agentId: 'triager', role: 'triager' },
        requiredEvidenceKinds: ['tdd_red_bundle'],
        evidenceKinds: ['tdd_red_bundle'],
        waivedEvidenceKinds: [],
        expectedVersion: 0,
        nextVersion: 1,
      })
      store.transitionLogRepo.appendTransition('T-10403', {
        taskId: 'T-10403',
        transitionEventId: 'TR-90004',
        timestamp: '2026-04-19T12:02:00.000Z',
        from: { lifecycleState: 'active', phase: 'red' },
        to: { lifecycleState: 'active', phase: 'green' },
        actor: { agentId: 'larry', role: 'implementer' },
        requiredEvidenceKinds: ['tdd_green_bundle'],
        evidenceKinds: ['tdd_green_bundle'],
        waivedEvidenceKinds: [],
        expectedVersion: 1,
        nextVersion: 2,
      })

      expect(
        store.transitionLogRepo.listTransitions('T-10403').map((item) => item.transitionEventId)
      ).toEqual(['TR-90003', 'TR-90004'])
    })
  })

  test('throws on missing task transition append', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      expect(() =>
        store.transitionLogRepo.appendTransition('T-40403', {
          taskId: 'T-40403',
          transitionEventId: 'TR-missing',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: { lifecycleState: 'open', phase: 'open' },
          to: { lifecycleState: 'open', phase: 'open' },
          actor: { agentId: 'cody', role: 'owner' },
          requiredEvidenceKinds: [],
          evidenceKinds: [],
          waivedEvidenceKinds: [],
          expectedVersion: 0,
          nextVersion: 1,
        })
      ).toThrow(WrkqTaskNotFoundError)
    })
  })
})
