/**
 * T-04784 Phase 2b — RED parity-characterization tests.
 *
 * These tests characterize the behavior that `createWrkqStoreAdapter` MUST
 * satisfy once implemented. They run against the REAL @wrkq/client binary
 * (WRKQ_BIN / ~/.local/bin/wrkq) and a fresh isolated temp DB provisioned by
 * wrkqadm init — the canonical ~/praesidium/var/db/wrkq.db is never touched.
 *
 * ALL tests in this file are RED until `src/adapter.ts` is created.
 * The import below fails with "Cannot find module" because the adapter module
 * does not exist yet. That is intentional — the test file IS the contract.
 *
 * Daedalus-approved mapping (T-04763 comment C-04677):
 *  - TaskStore.create/show/update  → wrkq.task.{create,show,update}
 *  - RoleAssignmentStore.get/set   → wrkf.role.list / wrkf.role.set (full-replace)
 *  - EvidenceStore.list/append     → wrkf.evidence.list/add
 *  - TransitionLogStore.list       → wrkq.workflow.timeline filtered to workflow.transitioned
 *  - TransitionLogStore.append     → NOT faithfully mappable; adapter throws (tests-only until P2d)
 *
 * projectId recovery: Task.projectId = container.show({ project: wrkqTask.projectUuid }).id
 * (no SQL — pure @wrkq/client RPC).
 *
 * evidenceKinds in listTransitions: empty arrays — not carried in timeline event payload.
 * Callers needing evidence provenance must query evidenceStore directly.
 */

// RED: this import fails until src/adapter.ts is created.
// The factory accepts a WorkClient and returns the 4 acp-core store ports.
import { createWrkqStoreAdapter } from '../src/adapter.js'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkRpcError, createClient } from '@wrkq/client'
import type { WorkClient } from '@wrkq/client'

import type { EvidenceItem, LoggedTransitionRecord } from 'acp-core'

// ---------------------------------------------------------------------------
// Binaries (override via env vars for CI)
// ---------------------------------------------------------------------------

const HOME = process.env['HOME'] ?? '/Users/lherron'
const WRKQ_BIN = process.env['WRKQ_BIN'] ?? `${HOME}/.local/bin/wrkq`
const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? `${HOME}/.local/bin/wrkqadm`

const DEMO_TEMPLATE_PATH = fileURLToPath(
  new URL('./fixtures/demo-linear-template.json', import.meta.url)
)
const DEMO_WORKFLOW_REF = 'demo-linear@1'

const T = 30_000 // 30 s per test (real subprocess)

// ---------------------------------------------------------------------------
// Single shared fixture for the entire file: one DB + one client + one adapter.
// ---------------------------------------------------------------------------

let client: WorkClient
let adapter: ReturnType<typeof createWrkqStoreAdapter>
let tmpDir: string
let inboxProjectId: string // wrkq container.id after wrkqadm init (e.g. "P-00001")

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrkq-adapter-parity-'))
  const dbPath = join(tmpDir, 'wrkq.db')

  const childEnv = { ...process.env, ASP_PROJECT: undefined, WRKQ_DB_PATH: undefined }
  const init = Bun.spawnSync([WRKQADM_BIN, '--db', dbPath, 'init'], { cwd: tmpDir, env: childEnv })
  if (init.exitCode !== 0) {
    throw new Error(`wrkqadm init failed: ${init.stderr.toString()}`)
  }

  // Principal-only caller attribution (T-05381): wrkq mutations require a
  // session principal (`agent:<id>`); the parity suite exercises real
  // task.create/update + wrkf role/evidence/transition mutations.
  client = await createClient({
    command: WRKQ_BIN,
    dbPath,
    principalRef: 'agent:wrkq-lib-parity',
    autoInitialize: true,
  })

  // Install demo-linear so role.set / transition.apply tests have a workflow to attach.
  await client.wrkf.workflow.install({ path: DEMO_TEMPLATE_PATH })

  // Discover inbox project's canonical id. wrkqadm init seeds one 'inbox' project.
  // container.show returns { id: 'P-00001', slug: 'inbox', ... }.
  // The adapter must use this same container.show RPC (no SQL) to recover Task.projectId.
  const inboxContainer = await client.wrkq.container.show({ project: 'inbox' })
  inboxProjectId = inboxContainer.id // e.g. "P-00001"

  adapter = createWrkqStoreAdapter(client)
}, T)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helper: create a task in the inbox project via the adapter's createTask.
// Returns the adapter-returned Task (with server-assigned taskId).
// ---------------------------------------------------------------------------

async function createAdapterTask(
  overrides: {
    riskClass?: string
    lifecycleState?: string
  } = {}
) {
  return adapter.taskStore.createTask({
    taskId: 'T-advisory-only', // server ignores this; assigns its own id
    projectId: 'inbox',
    kind: 'task',
    lifecycleState: overrides.lifecycleState ?? 'open',
    phase: null,
    riskClass: (overrides.riskClass ?? 'medium') as 'low' | 'medium' | 'high',
    roleMap: {},
    version: 0,
  })
}

// ===========================================================================
// 1. TaskStore
// ===========================================================================

describe('TaskStore — createTask round-trips riskClass', () => {
  test(
    'riskClass medium',
    async () => {
      const task = await createAdapterTask({ riskClass: 'medium' })
      expect(task.riskClass).toBe('medium')
    },
    T
  )

  test(
    'riskClass high',
    async () => {
      const task = await createAdapterTask({ riskClass: 'high' })
      expect(task.riskClass).toBe('high')
    },
    T
  )

  test(
    'riskClass low',
    async () => {
      const task = await createAdapterTask({ riskClass: 'low' })
      expect(task.riskClass).toBe('low')
    },
    T
  )
})

describe('TaskStore — projectId recovery via container.show (no SQL)', () => {
  test(
    'createTask returns projectId equal to container.id (not slug)',
    async () => {
      // The adapter must call container.show({ project: wrkqTask.projectUuid }) to
      // recover Task.projectId. The result is the container's id field (e.g. "P-00001"),
      // NOT the slug ("inbox"). This must work without any SQLite access.
      const task = await createAdapterTask()
      expect(task.projectId).toBe(inboxProjectId)
    },
    T
  )

  test(
    'getTask recovers projectId consistently with createTask',
    async () => {
      const created = await createAdapterTask()
      const loaded = await adapter.taskStore.getTask(created.taskId)

      expect(loaded?.projectId).toBe(inboxProjectId)
      expect(loaded?.projectId).toBe(created.projectId)
    },
    T
  )
})

describe('TaskStore — server-assigned taskId', () => {
  test(
    'createTask returns a server-assigned taskId (T-NNNNN format)',
    async () => {
      // wrkq.task.create does not accept a client-specified task id. The server assigns
      // one sequentially. The adapter must use the returned WrkqTask.id as Task.taskId.
      const task = await createAdapterTask()
      expect(task.taskId).toMatch(/^T-\d{5}$/)
    },
    T
  )

  test(
    'advisory input taskId is NOT preserved in returned Task.taskId',
    async () => {
      // Callers must use the server-returned taskId, not the input advisory id.
      // This is a documented behavioral change from the SQLite adapter.
      const task = await adapter.taskStore.createTask({
        taskId: 'T-99999',
        projectId: 'inbox',
        kind: 'task',
        lifecycleState: 'open',
        phase: null,
        riskClass: 'medium',
        roleMap: {},
        version: 0,
      })
      expect(task.taskId).not.toBe('T-99999')
    },
    T
  )
})

describe('TaskStore — MUST NOT forward legacy fields rejected by wrkq.task.update', () => {
  test(
    'createTask with workflowPreset/presetVersion/phase input succeeds without error',
    async () => {
      // wrkq.task.update now rejects phase/workflowPreset/presetVersion.
      // The adapter must strip them from create and update params.
      await expect(
        adapter.taskStore.createTask({
          taskId: 'T-legacy',
          projectId: 'inbox',
          kind: 'task',
          lifecycleState: 'open',
          phase: 'open',
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: {},
          version: 0,
        })
      ).resolves.toBeDefined()
    },
    T
  )

  test(
    'returned task does not expose workflowPreset or presetVersion',
    async () => {
      const task = await adapter.taskStore.createTask({
        taskId: 'T-legacy2',
        projectId: 'inbox',
        kind: 'task',
        lifecycleState: 'open',
        phase: 'open',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        riskClass: 'medium',
        roleMap: {},
        version: 0,
      })
      // The @wrkq/client surface does not expose these fields; adapter must not fabricate them.
      expect(task.workflowPreset).toBeUndefined()
      expect(task.presetVersion).toBeUndefined()
    },
    T
  )
})

describe('TaskStore — getTask', () => {
  test(
    'getTask returns undefined for non-existent task id',
    async () => {
      // The adapter must catch WRKQ_NOT_FOUND and return undefined (TaskStore contract).
      const result = await adapter.taskStore.getTask('T-99999')
      expect(result).toBeUndefined()
    },
    T
  )

  test(
    'getTask returns Task matching createTask output',
    async () => {
      const created = await createAdapterTask({ riskClass: 'high' })
      const loaded = await adapter.taskStore.getTask(created.taskId)

      expect(loaded).toBeDefined()
      expect(loaded?.taskId).toBe(created.taskId)
      expect(loaded?.riskClass).toBe('high')
    },
    T
  )
})

describe('TaskStore — updateTask with expectEtag CAS', () => {
  test(
    'updateTask increments version on success',
    async () => {
      const created = await createAdapterTask()
      const updated = await adapter.taskStore.updateTask({
        ...created,
        lifecycleState: 'active',
        riskClass: 'high',
      })
      expect(updated.version).toBeGreaterThan(created.version)
    },
    T
  )

  test(
    'updateTask round-trips riskClass change',
    async () => {
      const created = await createAdapterTask({ riskClass: 'low' })
      const updated = await adapter.taskStore.updateTask({ ...created, riskClass: 'high' })
      expect(updated.riskClass).toBe('high')
    },
    T
  )

  test(
    'updateTask stale version throws WorkRpcError',
    async () => {
      const created = await createAdapterTask()
      // Advance server state
      await adapter.taskStore.updateTask({ ...created, lifecycleState: 'active' })
      // Now attempt update with stale version — must throw
      await expect(
        adapter.taskStore.updateTask({ ...created, lifecycleState: 'blocked' })
      ).rejects.toThrow(WorkRpcError)
    },
    T
  )

  test(
    'version-conflict error has domainCode WRKQ_CONFLICT',
    async () => {
      const created = await createAdapterTask()
      await adapter.taskStore.updateTask({ ...created, lifecycleState: 'active' })

      let caught: unknown
      try {
        await adapter.taskStore.updateTask({ ...created, lifecycleState: 'blocked' })
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(WorkRpcError)
      expect((caught as WorkRpcError).domainCode).toBe('WRKQ_CONFLICT')
    },
    T
  )
})

// ===========================================================================
// 2. RoleAssignmentStore
// ===========================================================================

describe('RoleAssignmentStore — set/get via wrkf.role.set / wrkf.role.list', () => {
  let roleTaskId: string

  beforeAll(async () => {
    const task = await client.wrkq.task.create({ title: 'Role test', path: 'inbox/role-test' })
    roleTaskId = task.id
    await client.wrkq.workflow.attach({ task: roleTaskId, workflow: DEMO_WORKFLOW_REF })
  }, T)

  test(
    'setRoleMap sets role assignments',
    async () => {
      await adapter.roleAssignmentStore.setRoleMap(roleTaskId, {
        implementer: 'larry',
        tester: 'curly',
      })
      const roleMap = await adapter.roleAssignmentStore.getRoleMap(roleTaskId)
      expect(roleMap).toEqual({ implementer: 'larry', tester: 'curly' })
    },
    T
  )

  test(
    'setRoleMap full-replace removes roles not in the new map',
    async () => {
      await adapter.roleAssignmentStore.setRoleMap(roleTaskId, {
        implementer: 'larry',
        tester: 'curly',
      })
      await adapter.roleAssignmentStore.setRoleMap(roleTaskId, { agent: 'moe' })

      const roleMap = await adapter.roleAssignmentStore.getRoleMap(roleTaskId)
      expect(roleMap).toEqual({ agent: 'moe' })
      expect(roleMap).not.toHaveProperty('implementer')
      expect(roleMap).not.toHaveProperty('tester')
    },
    T
  )

  test(
    'setRoleMap empty map clears all role assignments',
    async () => {
      await adapter.roleAssignmentStore.setRoleMap(roleTaskId, { agent: 'larry' })
      await adapter.roleAssignmentStore.setRoleMap(roleTaskId, {})

      const roleMap = await adapter.roleAssignmentStore.getRoleMap(roleTaskId)
      expect(roleMap).toEqual({})
    },
    T
  )

  test(
    'getRoleMap returns empty map when no roles have been set yet',
    async () => {
      const freshTask = await client.wrkq.task.create({
        title: 'Fresh role',
        path: 'inbox/fresh-role-0',
      })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const roleMap = await adapter.roleAssignmentStore.getRoleMap(freshTask.id)
      expect(roleMap).toEqual({})
    },
    T
  )

  test(
    'getRoleMap for task without workflow instance surfaces WorkRpcError (WRKF_NOT_FOUND)',
    async () => {
      // wrkf.role.list requires a workflow instance. No attachment → WRKF_NOT_FOUND.
      const bareTask = await client.wrkq.task.create({
        title: 'No workflow',
        path: 'inbox/bare-role',
      })
      await expect(adapter.roleAssignmentStore.getRoleMap(bareTask.id)).rejects.toThrow(
        WorkRpcError
      )
    },
    T
  )

  test(
    'getRoleMap WorkRpcError domainCode is WRKF_NOT_FOUND for missing workflow instance',
    async () => {
      const bareTask = await client.wrkq.task.create({
        title: 'No workflow 2',
        path: 'inbox/bare-role-2',
      })
      let caught: unknown
      try {
        await adapter.roleAssignmentStore.getRoleMap(bareTask.id)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(WorkRpcError)
      expect((caught as WorkRpcError).domainCode).toBe('WRKF_NOT_FOUND')
    },
    T
  )
})

// ===========================================================================
// 3. EvidenceStore
// ===========================================================================

describe('EvidenceStore — append/list via wrkf.evidence.add / wrkf.evidence.list', () => {
  let evTaskId: string

  beforeAll(async () => {
    const task = await client.wrkq.task.create({
      title: 'Evidence test',
      path: 'inbox/evidence-test',
    })
    evTaskId = task.id
    await client.wrkq.workflow.attach({ task: evTaskId, workflow: DEMO_WORKFLOW_REF })
  }, T)

  test(
    'listEvidence returns empty array before any evidence is appended',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'Empty ev', path: 'inbox/empty-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const items = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(items).toEqual([])
    },
    T
  )

  test(
    'appendEvidence + listEvidence round-trips contentHash',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'Hash ev', path: 'inbox/hash-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const ev: EvidenceItem = {
        kind: 'demo_note',
        ref: 'artifact://notes/hash-test',
        contentHash: 'sha256:deadbeef',
        producedBy: { agentId: 'cody', role: 'agent' },
      }

      await adapter.evidenceStore.appendEvidence(freshTask.id, [ev])

      const items = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(items).toHaveLength(1)
      expect(items[0]?.contentHash).toBe('sha256:deadbeef')
    },
    T
  )

  test(
    'appendEvidence + listEvidence round-trips build metadata',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'Build ev', path: 'inbox/build-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const ev: EvidenceItem = {
        kind: 'demo_note',
        ref: 'artifact://build/1',
        producedBy: { agentId: 'ci-bot', role: 'agent' },
        build: { id: 'build-42', version: '3.2.1', env: 'staging' },
      }

      await adapter.evidenceStore.appendEvidence(freshTask.id, [ev])

      const items = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(items[0]?.build?.id).toBe('build-42')
      expect(items[0]?.build?.version).toBe('3.2.1')
      expect(items[0]?.build?.env).toBe('staging')
    },
    T
  )

  test(
    'appendEvidence + listEvidence round-trips producedBy (agentId + role)',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'By ev', path: 'inbox/by-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const ev: EvidenceItem = {
        kind: 'demo_note',
        ref: 'artifact://by/1',
        producedBy: { agentId: 'tester-bot', role: 'agent' },
      }

      await adapter.evidenceStore.appendEvidence(freshTask.id, [ev])

      const items = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(items[0]?.producedBy?.agentId).toBe('tester-bot')
      expect(items[0]?.producedBy?.role).toBe('agent')
    },
    T
  )

  test(
    'appendEvidence batch — all items visible in listEvidence',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'Batch ev', path: 'inbox/batch-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const items: EvidenceItem[] = [
        {
          kind: 'demo_note',
          ref: 'artifact://batch/1',
          producedBy: { agentId: 'a1', role: 'agent' },
        },
        {
          kind: 'demo_note',
          ref: 'artifact://batch/2',
          producedBy: { agentId: 'a2', role: 'agent' },
        },
      ]

      await adapter.evidenceStore.appendEvidence(freshTask.id, items)

      const listed = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(listed).toHaveLength(2)
      expect(listed.map((i) => i.ref).sort()).toEqual(['artifact://batch/1', 'artifact://batch/2'])
    },
    T
  )

  test(
    'listEvidence timestamp field is populated (ISO string)',
    async () => {
      const freshTask = await client.wrkq.task.create({ title: 'Ts ev', path: 'inbox/ts-ev' })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      await adapter.evidenceStore.appendEvidence(freshTask.id, [
        { kind: 'demo_note', ref: 'artifact://ts/1' },
      ])

      const items = await adapter.evidenceStore.listEvidence(freshTask.id)
      expect(typeof items[0]?.timestamp).toBe('string')
      expect(() => new Date(items[0]?.timestamp ?? '')).not.toThrow()
    },
    T
  )

  test(
    'appendEvidence for task without workflow instance surfaces WorkRpcError',
    async () => {
      const bareTask = await client.wrkq.task.create({ title: 'Bare ev', path: 'inbox/bare-ev' })
      await expect(
        adapter.evidenceStore.appendEvidence(bareTask.id, [
          { kind: 'demo_note', ref: 'artifact://bare/1' },
        ])
      ).rejects.toThrow(WorkRpcError)
    },
    T
  )
})

// ===========================================================================
// 4. TransitionLogStore
// ===========================================================================

describe('TransitionLogStore — listTransitions via wrkq.workflow.timeline', () => {
  let trTaskId: string
  let transitionEventId: string

  beforeAll(async () => {
    // Create task, attach demo-linear, bind agent role, add demo_note evidence,
    // then apply the submit transition. This puts one workflow.transitioned event
    // in the timeline for listTransitions to map.
    const task = await client.wrkq.task.create({
      title: 'Transition test',
      path: 'inbox/tr-test',
      riskClass: 'high',
    })
    trTaskId = task.id

    await client.wrkq.workflow.attach({ task: trTaskId, workflow: DEMO_WORKFLOW_REF })
    await client.wrkf.role.set({ task: trTaskId, roleMap: { agent: 'larry' } })
    await client.wrkf.evidence.add({
      task: trTaskId,
      kind: 'demo_note',
      ref: 'artifact://tr-setup-note',
      actor: 'larry',
      role: 'agent',
    })

    const tr = await client.wrkf.transition.apply({
      task: trTaskId,
      transition: 'submit',
      actor: 'larry',
      role: 'agent',
    })
    transitionEventId = tr.eventId
  }, T)

  test(
    'listTransitions returns empty array for task with no transitions applied',
    async () => {
      const freshTask = await client.wrkq.task.create({
        title: 'No transitions',
        path: 'inbox/no-tr',
      })
      await client.wrkq.workflow.attach({ task: freshTask.id, workflow: DEMO_WORKFLOW_REF })

      const transitions = await adapter.transitionLogStore.listTransitions(freshTask.id)
      expect(transitions).toEqual([])
    },
    T
  )

  test(
    'listTransitions returns one record after one transition is applied',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions).toHaveLength(1)
    },
    T
  )

  test(
    'listTransitions — transitionEventId matches the wrkf workflow event id',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.transitionEventId).toBe(transitionEventId)
    },
    T
  )

  test(
    'listTransitions — taskId on record matches the queried task',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.taskId).toBe(trTaskId)
    },
    T
  )

  test(
    'listTransitions — from lifecycleState + phase come from timeline payload.from',
    async () => {
      // demo-linear submit transitions from: { status:"open", phase:"start" }
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.from.lifecycleState).toBe('open')
      expect(transitions[0]?.from.phase).toBe('start')
    },
    T
  )

  test(
    'listTransitions — to lifecycleState + phase come from timeline payload.to',
    async () => {
      // demo-linear submit transitions to: { status:"waiting", phase:"review" }
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.to.lifecycleState).toBe('waiting')
      expect(transitions[0]?.to.phase).toBe('review')
    },
    T
  )

  test(
    'listTransitions — actor.agentId extracted from timeline event actor field',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.actor.agentId).toBe('larry')
    },
    T
  )

  test(
    'listTransitions — actor.role extracted from timeline event role field',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.actor.role).toBe('agent')
    },
    T
  )

  test(
    'listTransitions — timestamp is an ISO string from timeline event createdAt',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      const record = transitions[0] as LoggedTransitionRecord

      expect(typeof record.timestamp).toBe('string')
      expect(() => new Date(record.timestamp)).not.toThrow()
    },
    T
  )

  test(
    'listTransitions — expectedVersion = timeline observedRevision (0 for first transition)',
    async () => {
      // demo-linear fresh: observedRevision=0 (no prior transitions), nextRevision=1.
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.expectedVersion).toBe(0)
    },
    T
  )

  test(
    'listTransitions — nextVersion = timeline nextRevision (1 after first transition)',
    async () => {
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.nextVersion).toBe(1)
    },
    T
  )

  test(
    'listTransitions — evidenceKinds is empty (not carried in timeline event payload)',
    async () => {
      // KNOWN LIMITATION: wrkq.workflow.timeline events do not include evidenceKinds.
      // The adapter returns [] for all three evidence kind arrays.
      // Callers needing evidence provenance must query evidenceStore separately.
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      expect(transitions[0]?.evidenceKinds).toEqual([])
      expect(transitions[0]?.requiredEvidenceKinds).toEqual([])
      expect(transitions[0]?.waivedEvidenceKinds).toEqual([])
    },
    T
  )

  test(
    'listTransitions filters out non-transitioned events (workflow.attached is excluded)',
    async () => {
      // wrkq.workflow.attach emits a workflow.attached event. The adapter must only
      // include workflow.transitioned events. We applied exactly one transition in
      // beforeAll; the attached event must NOT appear.
      const transitions = await adapter.transitionLogStore.listTransitions(trTaskId)
      // Exactly one transition record (the submit), not two (attached + submit)
      expect(transitions).toHaveLength(1)
    },
    T
  )
})

describe('TransitionLogStore — appendTransition (not faithfully mappable)', () => {
  test(
    'appendTransition throws — adapter cannot preserve id/timestamp/version (documented choice)',
    async () => {
      // wrkf.transition.apply cannot accept a raw LoggedTransitionRecord: it cannot
      // preserve the caller-specified transitionEventId, timestamp, or version fields.
      // The adapter throws an error rather than silently losing fidelity.
      //
      // Daedalus ruling T-04763 C-04677: "do not lie about preservation."
      // This port method is tests-only until removed in P2d.
      const task = await client.wrkq.task.create({
        title: 'Append tr test',
        path: 'inbox/append-tr',
      })

      const fakeRecord: LoggedTransitionRecord = {
        taskId: task.id,
        transitionEventId: 'TR-fake-00001',
        timestamp: '2026-06-15T00:00:00.000Z',
        from: { lifecycleState: 'open', phase: 'start' },
        to: { lifecycleState: 'waiting', phase: 'review' },
        actor: { agentId: 'larry', role: 'agent' },
        requiredEvidenceKinds: [],
        evidenceKinds: [],
        waivedEvidenceKinds: [],
        expectedVersion: 0,
        nextVersion: 1,
      }

      await expect(
        adapter.transitionLogStore.appendTransition(task.id, fakeRecord)
      ).rejects.toThrow()
    },
    T
  )
})
