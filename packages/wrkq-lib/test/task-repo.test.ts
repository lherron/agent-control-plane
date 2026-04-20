import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VersionConflictError, WrkqSchemaMissingError, openWrkqStore } from '../src/index.js'
import { withSeededWrkqDb } from './fixtures/seed-wrkq-db.js'

import type { Task } from 'acp-core'
import Database from 'better-sqlite3'

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: overrides.taskId ?? 'T-90001',
    projectId: overrides.projectId ?? 'demo',
    kind: overrides.kind ?? 'code_change',
    ...('workflowPreset' in overrides
      ? { workflowPreset: overrides.workflowPreset }
      : { workflowPreset: 'code_defect_fastlane' }),
    ...('presetVersion' in overrides
      ? { presetVersion: overrides.presetVersion }
      : { presetVersion: 1 }),
    lifecycleState: overrides.lifecycleState ?? 'active',
    phase: overrides.phase ?? 'open',
    ...('riskClass' in overrides ? { riskClass: overrides.riskClass } : { riskClass: 'medium' }),
    roleMap: overrides.roleMap ?? { implementer: 'larry', tester: 'curly' },
    version: overrides.version ?? 0,
    ...(overrides.meta !== undefined ? { meta: overrides.meta } : {}),
  }
}

describe('TaskRepo', () => {
  test('creates and reads a preset-driven task with role assignments', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({
        dbPath: fixture.dbPath,
        actor: { agentId: 'cody', displayName: 'Cody' },
      })

      const created = store.taskRepo.createTask(
        createTask({
          taskId: 'T-10101',
          projectId: fixture.seed.projectSlug,
          meta: { severity: 's2' },
        })
      )
      const loaded = store.taskRepo.getTask('T-10101')

      expect(created.taskId).toBe('T-10101')
      expect(created.projectId).toBe(fixture.seed.projectId)
      expect(created.lifecycleState).toBe('active')
      expect(created.version).toBe(0)
      expect(created.kind).toBe('code_change')
      expect(created.meta).toEqual({ severity: 's2' })
      expect(created.roleMap).toEqual({ implementer: 'larry', tester: 'curly' })
      expect(loaded).toEqual(created)
    })
  })

  test('returns undefined for a missing task', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      expect(store.taskRepo.getTask('T-40404')).toBeUndefined()
    })
  })

  test('updates a task and bumps the version via etag', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask(createTask({ taskId: 'T-10102' }))

      const updated = store.taskRepo.updateTask(
        createTask({
          taskId: 'T-10102',
          projectId: fixture.seed.secondaryProjectId,
          kind: 'verified_fix',
          lifecycleState: 'blocked',
          phase: 'green',
          version: 0,
          roleMap: { owner: 'olivia' },
          meta: { note: 'updated' },
        })
      )

      expect(updated.projectId).toBe(fixture.seed.secondaryProjectId)
      expect(updated.lifecycleState).toBe('blocked')
      expect(updated.phase).toBe('green')
      expect(updated.version).toBe(1)
      expect(updated.kind).toBe('verified_fix')
      expect(updated.roleMap).toEqual({ owner: 'olivia' })
      expect(updated.meta).toEqual({ note: 'updated' })
    })
  })

  test('throws VersionConflictError on stale task update', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      store.taskRepo.createTask(createTask({ taskId: 'T-10103' }))
      store.taskRepo.updateTask(createTask({ taskId: 'T-10103', version: 0 }))

      expect(() =>
        store.taskRepo.updateTask(createTask({ taskId: 'T-10103', version: 0 }))
      ).toThrow(VersionConflictError)
    })
  })

  test('passes through non-ACP wrkq task states when reading', () => {
    withSeededWrkqDb((fixture) => {
      const sqlite = new Database(fixture.dbPath)
      sqlite
        .prepare(
          `INSERT INTO tasks (
             id,
             slug,
             title,
             project_uuid,
             state,
             priority,
             kind,
             description,
             specification,
             meta,
             etag,
             created_by_actor_uuid,
             updated_by_actor_uuid
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'T-10104',
          't-10104',
          'T-10104',
          fixture.seed.projectUuid,
          'idea',
          3,
          'task',
          '',
          '',
          JSON.stringify({ acp: { kind: 'backlog_item' } }),
          7,
          fixture.seed.bootstrapActorUuid,
          fixture.seed.bootstrapActorUuid
        )
      sqlite.close()

      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      const loaded = store.taskRepo.getTask('T-10104')

      expect(loaded?.lifecycleState).toBe('idea')
      expect(loaded?.version).toBe(7)
      expect(loaded?.kind).toBe('backlog_item')
    })
  })

  test('supports non-preset tasks with empty ACP phase and NULL wrkq phase', () => {
    withSeededWrkqDb((fixture) => {
      const store = openWrkqStore({ dbPath: fixture.dbPath, actor: { agentId: 'cody' } })
      const created = store.taskRepo.createTask(
        createTask({
          taskId: 'T-10105',
          workflowPreset: undefined,
          presetVersion: undefined,
          phase: '',
          riskClass: undefined,
        })
      )

      expect(created.workflowPreset).toBeUndefined()
      expect(created.presetVersion).toBeUndefined()
      expect(created.phase).toBe('')
      expect(created.riskClass).toBeUndefined()
    })
  })

  test('fails fast when the wrkq schema is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wrkq-lib-missing-schema-'))
    const dbPath = join(directory, 'wrkq.db')
    const blank = new Database(dbPath)
    blank.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)')
    blank.close()

    try {
      expect(() => openWrkqStore({ dbPath, actor: { agentId: 'cody' } })).toThrow(
        WrkqSchemaMissingError
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
