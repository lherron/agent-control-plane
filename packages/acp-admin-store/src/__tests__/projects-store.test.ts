import { describe, expect, test } from 'bun:test'
import type { Actor } from 'acp-core'

import { type AdminStore, createInMemoryAdminStore, openSqliteAdminStore } from '../index.js'

type AdminProjectRecord = {
  projectId: string
  displayName: string
  defaultAgentId?: string | undefined
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
}

type CreateProjectInput = {
  projectId: string
  displayName: string
  actor: Actor
  now: string
}

type ProjectsStore = {
  create(input: CreateProjectInput): AdminProjectRecord
  list(): AdminProjectRecord[]
  get(projectId: string): AdminProjectRecord | undefined
  setDefaultAgent(input: { projectId: string; agentId: string; actor: Actor; now: string }):
    | AdminProjectRecord
    | undefined
}

function expectProjectsStore(store: AdminStore): ProjectsStore {
  const projects = (store as AdminStore & { projects?: ProjectsStore }).projects
  expect(projects).toBeDefined()
  return projects as ProjectsStore
}

const ACTOR = {
  kind: 'agent',
  id: 'smokey',
  displayName: 'Smokey',
} satisfies Actor

describe('admin projects store acceptance', () => {
  test('exports dedicated project store helpers', async () => {
    const module = (await import('../index.js')) as Record<string, unknown>

    expect(module['createInMemoryProjectsStore']).toBeFunction()
    expect(module['openSqliteProjectsStore']).toBeFunction()
  })

  test('creates idempotently by projectId and lists persisted projects', () => {
    const store = createInMemoryAdminStore()

    try {
      const projects = expectProjectsStore(store)
      const created = projects.create({
        projectId: 'agent-spaces',
        displayName: 'Agent Spaces',
        actor: ACTOR,
        now: '2026-04-23T03:00:00.000Z',
      })
      const repeated = projects.create({
        projectId: 'agent-spaces',
        displayName: 'Agent Spaces',
        actor: ACTOR,
        now: '2026-04-23T03:01:00.000Z',
      })

      expect(repeated).toEqual(created)
      expect(projects.list()).toEqual([created])
      expect(projects.get('agent-spaces')).toEqual(created)
    } finally {
      store.close()
    }
  })

  test('sets a default agent without mutating the creation stamp', () => {
    const store = createInMemoryAdminStore()

    try {
      const projects = expectProjectsStore(store)
      projects.create({
        projectId: 'wrkq',
        displayName: 'Wrkq',
        actor: ACTOR,
        now: '2026-04-23T03:05:00.000Z',
      })

      const updated = projects.setDefaultAgent({
        projectId: 'wrkq',
        agentId: 'smokey',
        actor: { kind: 'human', id: 'operator' },
        now: '2026-04-23T03:06:00.000Z',
      })

      expect(updated).toEqual({
        projectId: 'wrkq',
        displayName: 'Wrkq',
        defaultAgentId: 'smokey',
        createdAt: '2026-04-23T03:05:00.000Z',
        updatedAt: '2026-04-23T03:06:00.000Z',
        createdBy: ACTOR,
        updatedBy: { kind: 'human', id: 'operator' },
      })
      expect(projects.get('wrkq')).toEqual(updated)
    } finally {
      store.close()
    }
  })

  test('supports the sqlite-backed helper for persistence semantics', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })

    try {
      const projects = expectProjectsStore(store)
      projects.create({
        projectId: 'taskboard',
        displayName: 'Taskboard',
        actor: ACTOR,
        now: '2026-04-23T03:10:00.000Z',
      })

      expect(projects.list()).toEqual([
        expect.objectContaining({
          projectId: 'taskboard',
          displayName: 'Taskboard',
        }),
      ])
    } finally {
      store.close()
    }
  })
})
