import { describe, expect, test } from 'bun:test'

import { applyTransitionDecision, getPreset, validateTransition } from 'acp-core'

import { VersionConflictError, openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

describe('wrkq-lib integration', () => {
  test('round-trips task, roles, evidence, transition, and optimistic concurrency', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'acp-server' } })

      const created = store.taskRepo.createTask({
        taskId: 'T-10501',
        projectId: fixture.seed.projectSlug,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'red',
        riskClass: 'medium',
        roleMap: { implementer: 'larry' },
        version: 0,
        meta: { intake: 'api' },
      })

      store.roleAssignmentRepo.setRoleMap('T-10501', {
        triager: 'tracy',
        implementer: 'larry',
        tester: 'curly',
      })
      store.evidenceRepo.appendEvidence('T-10501', [
        {
          kind: 'tdd_green_bundle',
          ref: 'artifact://green/1',
          producedBy: { agentId: 'larry', role: 'implementer' },
        },
      ])
      store.transitionLogRepo.appendTransition('T-10501', {
        taskId: 'T-10501',
        transitionEventId: 'TR-90010',
        timestamp: '2026-04-19T12:15:00.000Z',
        from: { lifecycleState: 'active', phase: 'red' },
        to: { lifecycleState: 'active', phase: 'green' },
        actor: { agentId: 'larry', role: 'implementer' },
        requiredEvidenceKinds: ['tdd_green_bundle'],
        evidenceKinds: ['tdd_green_bundle'],
        waivedEvidenceKinds: [],
        expectedVersion: 0,
        nextVersion: 1,
      })

      const updated = store.taskRepo.updateTask({
        ...created,
        phase: 'green',
        roleMap: { triager: 'tracy', implementer: 'larry', tester: 'curly' },
        version: 0,
      })

      expect(updated.version).toBe(1)
      expect(updated.phase).toBe('green')
      expect(updated.roleMap).toEqual({ triager: 'tracy', implementer: 'larry', tester: 'curly' })
      expect(store.evidenceRepo.listEvidence('T-10501')).toHaveLength(1)
      expect(store.transitionLogRepo.listTransitions('T-10501')).toHaveLength(1)
      expect(() => store.taskRepo.updateTask({ ...updated, version: 0 })).toThrow(
        VersionConflictError
      )
    })
  })

  test('works with acp-core transition validation', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'acp-server' } })
      const task = store.taskRepo.createTask({
        taskId: 'T-10502',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'red',
        riskClass: 'medium',
        roleMap: {
          triager: 'tracy',
          implementer: 'larry',
          tester: 'curly',
        },
        version: 0,
      })
      const evidence = [
        {
          kind: 'tdd_green_bundle',
          ref: 'artifact://green/2',
          producedBy: { agentId: 'larry', role: 'implementer' },
        },
      ]
      store.evidenceRepo.appendEvidence('T-10502', evidence)

      const validation = validateTransition({
        task,
        preset: getPreset('code_defect_fastlane', 1),
        actor: { agentId: 'larry', role: 'implementer' },
        toPhase: 'green',
        evidence,
        expectedVersion: 0,
      })

      expect(validation.ok).toBe(true)
      if (!validation.ok) {
        return
      }

      store.transitionLogRepo.appendTransition('T-10502', {
        taskId: 'T-10502',
        transitionEventId: 'TR-90011',
        timestamp: '2026-04-19T12:20:00.000Z',
        ...validation.transition.record,
      })
      const decidedTask = applyTransitionDecision(task, validation.transition)
      const updated = store.taskRepo.updateTask({ ...decidedTask, version: task.version })

      expect(updated.phase).toBe('green')
      expect(updated.version).toBe(1)
      expect(store.transitionLogRepo.listTransitions('T-10502')).toHaveLength(1)
    })
  })
})
