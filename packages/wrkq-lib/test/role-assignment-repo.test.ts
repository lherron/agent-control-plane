import { describe, expect, test } from 'bun:test'

import { openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

describe('RoleAssignmentRepo', () => {
  test('gets undefined for missing tasks', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      expect(store.roleAssignmentRepo.getRoleMap('T-40402')).toBeUndefined()
    })
  })

  test('returns an empty role map when no assignments exist', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10301',
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

      expect(store.roleAssignmentRepo.getRoleMap('T-10301')).toEqual({})
    })
  })

  test('sets and gets role assignments', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10302',
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

      store.roleAssignmentRepo.setRoleMap('T-10302', { implementer: 'larry', reviewer: 'moe' })

      expect(store.roleAssignmentRepo.getRoleMap('T-10302')).toEqual({
        implementer: 'larry',
        reviewer: 'moe',
      })
    })
  })

  test('replace-all semantics delete removed assignments', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask({
        taskId: 'T-10303',
        projectId: fixture.seed.projectId,
        kind: 'code_change',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        lifecycleState: 'active',
        phase: 'open',
        riskClass: 'medium',
        roleMap: { implementer: 'larry', tester: 'curly' },
        version: 0,
      })

      store.roleAssignmentRepo.setRoleMap('T-10303', { tester: 'curly' })

      expect(store.roleAssignmentRepo.getRoleMap('T-10303')).toEqual({ tester: 'curly' })
    })
  })
})
