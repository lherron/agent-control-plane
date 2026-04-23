import { describe, expect, test } from 'bun:test'
import type { Actor } from 'acp-core'

import { createInMemoryAdminStore } from '../index.js'

const ACTOR = {
  kind: 'agent',
  id: 'operator',
} satisfies Actor

describe('GAP 1: placement metadata persistence', () => {
  test('agent create persists homeDir', () => {
    const store = createInMemoryAdminStore()
    try {
      const agent = store.agents.create({
        agentId: 'curly',
        homeDir: '/home/curly',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(agent.homeDir).toBe('/home/curly')
      expect(store.agents.get('curly')?.homeDir).toBe('/home/curly')
    } finally {
      store.close()
    }
  })

  test('agent create without homeDir omits it from result', () => {
    const store = createInMemoryAdminStore()
    try {
      const agent = store.agents.create({
        agentId: 'larry',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(agent.homeDir).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('agent create rejects empty homeDir', () => {
    const store = createInMemoryAdminStore()
    try {
      expect(() =>
        store.agents.create({
          agentId: 'bad',
          homeDir: '',
          status: 'active',
          actor: ACTOR,
          now: '2026-04-23T10:00:00.000Z',
        })
      ).toThrow('homeDir must not be empty')
    } finally {
      store.close()
    }
  })

  test('agent create rejects whitespace-only homeDir', () => {
    const store = createInMemoryAdminStore()
    try {
      expect(() =>
        store.agents.create({
          agentId: 'bad',
          homeDir: '   ',
          status: 'active',
          actor: ACTOR,
          now: '2026-04-23T10:00:00.000Z',
        })
      ).toThrow('homeDir must not be empty')
    } finally {
      store.close()
    }
  })

  test('agent patch updates homeDir', () => {
    const store = createInMemoryAdminStore()
    try {
      store.agents.create({
        agentId: 'curly',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      const patched = store.agents.patch({
        agentId: 'curly',
        homeDir: '/new/home',
        actor: ACTOR,
        now: '2026-04-23T10:01:00.000Z',
      })

      expect(patched?.homeDir).toBe('/new/home')
    } finally {
      store.close()
    }
  })

  test('agent patch clears homeDir with null', () => {
    const store = createInMemoryAdminStore()
    try {
      store.agents.create({
        agentId: 'curly',
        homeDir: '/home/curly',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      const patched = store.agents.patch({
        agentId: 'curly',
        homeDir: null,
        actor: ACTOR,
        now: '2026-04-23T10:01:00.000Z',
      })

      expect(patched?.homeDir).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('agent patch preserves homeDir when not specified', () => {
    const store = createInMemoryAdminStore()
    try {
      store.agents.create({
        agentId: 'curly',
        homeDir: '/home/curly',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      const patched = store.agents.patch({
        agentId: 'curly',
        displayName: 'Curly Updated',
        actor: ACTOR,
        now: '2026-04-23T10:01:00.000Z',
      })

      expect(patched?.homeDir).toBe('/home/curly')
    } finally {
      store.close()
    }
  })

  test('project create persists rootDir', () => {
    const store = createInMemoryAdminStore()
    try {
      const project = store.projects.create({
        projectId: 'agent-spaces',
        displayName: 'Agent Spaces',
        rootDir: '/Users/dev/agent-spaces',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(project.rootDir).toBe('/Users/dev/agent-spaces')
      expect(store.projects.get('agent-spaces')?.rootDir).toBe('/Users/dev/agent-spaces')
    } finally {
      store.close()
    }
  })

  test('project create without rootDir omits it from result', () => {
    const store = createInMemoryAdminStore()
    try {
      const project = store.projects.create({
        projectId: 'wrkq',
        displayName: 'Wrkq',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(project.rootDir).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('project create rejects empty rootDir', () => {
    const store = createInMemoryAdminStore()
    try {
      expect(() =>
        store.projects.create({
          projectId: 'bad',
          displayName: 'Bad',
          rootDir: '',
          actor: ACTOR,
          now: '2026-04-23T10:00:00.000Z',
        })
      ).toThrow('rootDir must not be empty')
    } finally {
      store.close()
    }
  })

  test('homeDir appears in agents list', () => {
    const store = createInMemoryAdminStore()
    try {
      store.agents.create({
        agentId: 'alpha',
        homeDir: '/home/alpha',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })
      store.agents.create({
        agentId: 'beta',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T10:01:00.000Z',
      })

      const agents = store.agents.list()
      expect(agents[0]?.homeDir).toBe('/home/alpha')
      expect(agents[1]?.homeDir).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('rootDir appears in projects list', () => {
    const store = createInMemoryAdminStore()
    try {
      store.projects.create({
        projectId: 'p1',
        displayName: 'P1',
        rootDir: '/root/p1',
        actor: ACTOR,
        now: '2026-04-23T10:00:00.000Z',
      })
      store.projects.create({
        projectId: 'p2',
        displayName: 'P2',
        actor: ACTOR,
        now: '2026-04-23T10:01:00.000Z',
      })

      const projects = store.projects.list()
      expect(projects[0]?.rootDir).toBe('/root/p1')
      expect(projects[1]?.rootDir).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
