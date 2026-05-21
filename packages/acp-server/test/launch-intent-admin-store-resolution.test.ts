import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { Actor } from 'acp-core'

import type { LaunchIntentDeps } from '../src/launch-role-scoped.js'
import { resolveLaunchIntent } from '../src/launch-role-scoped.js'

// Regression coverage for the queue/wake-dispatch bug where resolveLaunchIntent
// was invoked without adminStore, so placement.cwd fell back to agentRoot
// instead of the admin-store project root (heather@vitals running in
// ~/var/agents/heather instead of ~/praesidium/vitals).
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

function buildDeps(input: {
  projectId: string
  bundle?: { kind: string; [key: string]: unknown }
}): LaunchIntentDeps {
  const adminStore = createInMemoryAdminStore()
  adminStore.projects.create({
    projectId: input.projectId,
    displayName: input.projectId,
    homeDir: ADMIN_HOME_DIR,
    actor: ACTOR,
    now: '2026-05-15T00:00:00.000Z',
  })

  return {
    adminStore,
    runtimeResolver: async () => ({
      agentRoot: WRONG_AGENT_ROOT,
      projectRoot: WRONG_PROJECT_ROOT,
      cwd: WRONG_CWD,
      runMode: 'task',
      bundle: input.bundle ?? { kind: 'compose', compose: [] },
      harness: { provider: 'anthropic', interactive: true },
    }),
    agentRootResolver: undefined,
  }
}

describe('resolveLaunchIntent admin-store project-root resolution', () => {
  test('placement.cwd and projectRoot resolve from adminStore homeDir even when runtimeResolver returns agent-root-ish values', async () => {
    const deps = buildDeps({ projectId: 'vitals' })

    const intent = await resolveLaunchIntent(deps, makeSessionRef('vitals'))

    expect(intent.placement.cwd).toBe(ADMIN_HOME_DIR)
    expect(intent.placement.projectRoot).toBe(ADMIN_HOME_DIR)
    expect(intent.placement.cwd).not.toBe(WRONG_AGENT_ROOT)
    expect(intent.placement.cwd).not.toBe(WRONG_CWD)
  })

  test('empty-compose bundle is rebuilt with the adminStore project root when runtimeResolver returns a degenerate bundle', async () => {
    // buildRuntimeBundleRef switches to 'agent-project' only if an agent-profile.toml
    // exists at agentRoot. Stage a real tempdir so the rebuild path produces a
    // non-default bundle wired to the adminStore homeDir.
    const agentRoot = mkdtempSync(join(tmpdir(), 'acp-launch-intent-agent-'))
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'name = "tester"\n')

    try {
      const adminStore = createInMemoryAdminStore()
      adminStore.projects.create({
        projectId: 'vitals',
        displayName: 'vitals',
        homeDir: ADMIN_HOME_DIR,
        actor: ACTOR,
        now: '2026-05-15T00:00:00.000Z',
      })

      const deps: LaunchIntentDeps = {
        adminStore,
        runtimeResolver: async () => ({
          agentRoot,
          projectRoot: WRONG_PROJECT_ROOT,
          cwd: WRONG_CWD,
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'anthropic', interactive: true },
        }),
        agentRootResolver: undefined,
      }

      const intent = await resolveLaunchIntent(deps, makeSessionRef('vitals'))

      const bundle = intent.placement.bundle as Record<string, unknown>
      expect(bundle['kind']).toBe('agent-project')
      expect(bundle['projectRoot']).toBe(ADMIN_HOME_DIR)
    } finally {
      rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  test('falls back to runtimeResolver projectRoot when adminStore has no entry for the project', async () => {
    const adminStore = createInMemoryAdminStore()
    // Intentionally no project registered.
    const deps: LaunchIntentDeps = {
      adminStore,
      runtimeResolver: async () => ({
        agentRoot: WRONG_AGENT_ROOT,
        projectRoot: WRONG_PROJECT_ROOT,
        cwd: WRONG_CWD,
        runMode: 'task',
        bundle: { kind: 'spaces-snapshot', snapshotId: 'snap-1' },
        harness: { provider: 'anthropic', interactive: true },
      }),
      agentRootResolver: undefined,
    }

    const intent = await resolveLaunchIntent(deps, makeSessionRef('unregistered'))

    expect(intent.placement.projectRoot).toBe(WRONG_PROJECT_ROOT)
    expect(intent.placement.cwd).toBe(WRONG_CWD)
  })
})
