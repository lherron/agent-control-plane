import { describe, expect, test } from 'bun:test'

import { WrkqTaskNotFoundError, openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

import type { EvidenceItem } from 'acp-core'

describe('EvidenceRepo', () => {
  test('defaults evidence producer to the store actor', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({
        dbPath: fixture.dbPath,
        actor: { agentId: 'cody', displayName: 'Cody' },
      })
      store.taskRepo.createTask({
        taskId: 'T-10201',
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

      store.evidenceRepo.appendEvidence('T-10201', [{ kind: 'qa_bundle', ref: 'artifact://qa/1' }])

      expect(store.evidenceRepo.listEvidence('T-10201')).toEqual([
        {
          kind: 'qa_bundle',
          ref: 'artifact://qa/1',
          producedBy: { agentId: 'cody', role: 'agent' },
          timestamp: expect.any(String),
        },
      ])
    })
  })

  test('preserves evidence overrides, build metadata, and details', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10202',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'red',
        riskClass: 'medium',
        roleMap: {},
        version: 0,
      })

      const evidence: EvidenceItem = {
        kind: 'waiver',
        ref: 'artifact://waivers/1',
        contentHash: 'sha256:abc',
        producedBy: { agentId: 'tester-bot', role: 'tester' },
        timestamp: '2026-04-19T12:00:00.000Z',
        build: { id: 'build-7', version: '1.2.3', env: 'ci' },
        details: { waiverKind: 'qa_bundle', scope: 'red->green', reason: 'manual approval' },
      }

      store.evidenceRepo.appendEvidence('T-10202', [evidence])

      expect(store.evidenceRepo.listEvidence('T-10202')).toEqual([evidence])
    })
  })

  test('lists evidence in produced_at order', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10203',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'green',
        riskClass: 'medium',
        roleMap: {},
        version: 0,
      })

      store.evidenceRepo.appendEvidence('T-10203', [
        { kind: 'later', ref: 'artifact://2', timestamp: '2026-04-19T12:02:00.000Z' },
        { kind: 'earlier', ref: 'artifact://1', timestamp: '2026-04-19T12:01:00.000Z' },
      ])

      expect(store.evidenceRepo.listEvidence('T-10203').map((item) => item.kind)).toEqual([
        'earlier',
        'later',
      ])
    })
  })

  test('throws on evidence writes for missing tasks', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })

      expect(() => store.evidenceRepo.appendEvidence('T-40401', [])).toThrow(WrkqTaskNotFoundError)
    })
  })
})
