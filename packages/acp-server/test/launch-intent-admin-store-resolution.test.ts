import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { Actor } from 'acp-core'

import type { LaunchIntentDeps } from '../src/launch-role-scoped.js'
import { resolveLaunchIntent } from '../src/launch-role-scoped.js'

// Degenerate-bundle rebuild against the admin-store project root. The wake
// path's admin-store cwd regression (heather@vitals running in
// ~/var/agents/heather instead of ~/praesidium/vitals) is guarded through the
// dispatcher in wake-dispatcher.test.ts; this seam test stays until the wake
// dispatcher accepts a placementFetch (production change, rewrite-held).
//
// Fixture deliberately makes runtimeResolver return WRONG paths so the test
// fails for the exact missing-adminStore class of bug, not because fixture
// values happened to align.

const ACTOR = { kind: 'agent', id: 'tester' } satisfies Actor

const ADMIN_HOME_DIR = '/admin/project/home'
const WRONG_AGENT_ROOT = '/agent/root/wrong'
const WRONG_PROJECT_ROOT = '/agent/root/wrong-project'
const WRONG_CWD = '/agent/root/wrong-cwd'

function makeSessionRef(projectId: string): { scopeRef: string; laneRef: string } {
  return {
    scopeRef: `agent:tester:project:${projectId}:task:T-42:role:tester`,
    laneRef: 'main',
  }
}

describe('resolveLaunchIntent admin-store project-root resolution', () => {
  test('degenerate compose bundle is re-resolved against the admin-store project root', async () => {
    const adminStore = createInMemoryAdminStore()
    adminStore.projects.create({
      projectId: 'vitals',
      displayName: 'vitals',
      homeDir: ADMIN_HOME_DIR,
      actor: ACTOR,
      now: '2026-05-15T00:00:00.000Z',
    })

    const seen: unknown[] = []
    const deps: LaunchIntentDeps = {
      adminStore,
      runtimeResolver: async () => ({
        agentRoot: WRONG_AGENT_ROOT,
        projectRoot: WRONG_PROJECT_ROOT,
        cwd: WRONG_CWD,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        harness: { provider: 'anthropic', interactive: true },
      }),
      agentRootResolver: undefined,
      placementFetch: async (input) => {
        seen.push(input)
        return {
          agentRoot: WRONG_AGENT_ROOT,
          projectRoot: ADMIN_HOME_DIR,
          cwd: ADMIN_HOME_DIR,
          bundle: {
            kind: 'agent-project',
            agentName: 'tester',
            projectRoot: ADMIN_HOME_DIR,
          },
          harness: { provider: 'anthropic', interactive: true },
        }
      },
    }

    const intent = await resolveLaunchIntent(deps, makeSessionRef('vitals'))

    const bundle = intent.placement.bundle as Record<string, unknown>
    expect(bundle['kind']).toBe('agent-project')
    expect(bundle['projectRoot']).toBe(ADMIN_HOME_DIR)
    expect(seen).toEqual([
      {
        scopeRef: 'agent:tester:project:vitals:task:T-42:role:tester',
        projectRoot: ADMIN_HOME_DIR,
        runMode: 'task',
      },
    ])
  })
})
