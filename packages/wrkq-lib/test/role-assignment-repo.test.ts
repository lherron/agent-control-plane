import { describe, expect, test } from 'bun:test'

import { openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

describe('RoleAssignmentRepo', () => {
  test('gets undefined for missing tasks', async () => {
    await withSeededWrkqDb(async (fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      expect(await store.roleAssignmentRepo.getRoleMap('T-40402')).toBeUndefined()
    })
  })

  test('returns an empty role map when no assignments exist', async () => {
    await withSeededWrkqDb(async (fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      await store.taskRepo.createTask({
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

      expect(await store.roleAssignmentRepo.getRoleMap('T-10301')).toEqual({})
    })
  })

  test('sets and gets role assignments', async () => {
    await withSeededWrkqDb(async (fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      await store.taskRepo.createTask({
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

      await store.roleAssignmentRepo.setRoleMap('T-10302', { implementer: 'larry', reviewer: 'moe' })

      expect(await store.roleAssignmentRepo.getRoleMap('T-10302')).toEqual({
        implementer: 'larry',
        reviewer: 'moe',
      })
    })
  })

  test('replace-all semantics delete removed assignments', async () => {
    await withSeededWrkqDb(async (fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      await store.taskRepo.createTask({
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

      await store.roleAssignmentRepo.setRoleMap('T-10303', { tester: 'curly' })

      expect(await store.roleAssignmentRepo.getRoleMap('T-10303')).toEqual({ tester: 'curly' })
    })
  })
})
