import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { applyTransitionDecision, getPreset, validateTransition } from 'acp-core'
import { type AcpStateStore, openAcpStateStore } from 'acp-state-store'
import {
  type CoordinationStore,
  listEvents,
  listOpenHandoffs,
  listPendingWakes,
  openCoordinationStore,
} from 'coordination-substrate'
import { type WrkqStore, openWrkqStore } from 'wrkq-lib'

import type { LoggedTransitionRecord, Task } from 'acp-core'
import type { SeededWrkqFixture } from '../../wrkq-lib/test/fixtures/seed-wrkq-db.js'

import { createEvidence, createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { createSeededWrkqDb } from '../../wrkq-lib/test/fixtures/seed-wrkq-db.js'
import { buildTesterSessionRef } from '../src/integration/handoff-on-transition.js'

type TransitionOutboxReconcilerModule = {
  reconcileTransitionOutbox(input: {
    wrkqStore: WrkqStore
    stateStore: AcpStateStore
    coordStore: CoordinationStore
  }): Promise<unknown>
}

type TransitionOutboxFixture = {
  wrkqStore: WrkqStore
  coordStore: CoordinationStore
  stateStore: AcpStateStore
  seed: SeededWrkqFixture['seed']
}

type TransitionOutboxRow = {
  transition_event_id: string
  status: string
  leased_at: string | null
  delivered_at: string | null
  attempts: number
  last_error: string | null
}

async function withTransitionOutboxFixture<T>(
  run: (fixture: TransitionOutboxFixture) => Promise<T> | T
): Promise<T> {
  const seededWrkq = createSeededWrkqDb()
  const coordDirectory = mkdtempSync(join(tmpdir(), 'acp-transition-coord-'))
  const stateDirectory = mkdtempSync(join(tmpdir(), 'acp-transition-state-'))
  const coordDbPath = join(coordDirectory, 'acp-coordination.db')
  const stateDbPath = join(stateDirectory, 'acp-state.db')
  const wrkqStore = openWrkqStore({
    dbPath: seededWrkq.dbPath,
    actor: { agentId: 'acp-server' },
  })
  const coordStore = openCoordinationStore(coordDbPath)
  const stateStore = openAcpStateStore({ dbPath: stateDbPath })

  try {
    return await run({
      wrkqStore,
      coordStore,
      stateStore,
      seed: seededWrkq.seed,
    })
  } finally {
    stateStore.close()
    coordStore.close()
    wrkqStore.close()
    rmSync(stateDirectory, { recursive: true, force: true })
    rmSync(coordDirectory, { recursive: true, force: true })
    seededWrkq.cleanup()
  }
}

async function loadReconciler(cacheBust: string): Promise<TransitionOutboxReconcilerModule> {
  void cacheBust
  const modulePath = '../src/integration/transition-outbox-reconciler.js'
  return (await import(modulePath)) as TransitionOutboxReconcilerModule
}

function createRedTask(fixture: TransitionOutboxFixture, taskId: string): Task {
  const task = fixture.wrkqStore.taskRepo.createTask(
    createTestTask({
      taskId,
      projectId: fixture.seed.projectId,
      phase: 'red',
      riskClass: 'medium',
    })
  )

  fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [createEvidence('tdd_green_bundle')])
  return task
}

function appendRedToGreenTransitionOnly(
  fixture: TransitionOutboxFixture,
  taskId: string,
  transitionEventId: string
): LoggedTransitionRecord {
  const task = fixture.wrkqStore.taskRepo.getTask(taskId)
  if (task === undefined) {
    throw new Error(`task not found: ${taskId}`)
  }

  const roleMap = fixture.wrkqStore.roleAssignmentRepo.getRoleMap(taskId) ?? task.roleMap
  const preset = getPreset(task.workflowPreset ?? '', task.presetVersion ?? 0)
  const validation = validateTransition({
    task: { ...task, roleMap },
    preset,
    actor: { agentId: 'larry', role: 'implementer' },
    toPhase: 'green',
    evidence: fixture.wrkqStore.evidenceRepo.listEvidence(taskId),
    expectedVersion: task.version,
  })

  if (!validation.ok) {
    throw new Error(`expected red -> green validation to pass for ${taskId}`)
  }

  const loggedTransition: LoggedTransitionRecord = {
    taskId,
    transitionEventId,
    timestamp: '2026-04-23T01:02:03.000Z',
    ...validation.transition.record,
  }
  const updatedTask = applyTransitionDecision({ ...task, roleMap }, validation.transition)

  fixture.wrkqStore.runInTransaction((store) => {
    store.taskRepo.updateTask({ ...updatedTask, roleMap, version: task.version })
    store.transitionLogRepo.appendTransition(taskId, loggedTransition)
  })

  return loggedTransition
}

function appendOutboxRow(
  fixture: TransitionOutboxFixture,
  transition: LoggedTransitionRecord,
  testerAgentId = 'curly'
): void {
  fixture.stateStore.transitionOutbox.append({
    transitionEventId: transition.transitionEventId,
    taskId: transition.taskId,
    projectId: fixture.seed.projectId,
    fromPhase: transition.from.phase,
    toPhase: transition.to.phase,
    payload: {
      transitionTimestamp: transition.timestamp,
      actor: transition.actor,
      testerAgentId,
    },
  })
}

function readOutboxRow(
  fixture: TransitionOutboxFixture,
  transitionEventId: string
): TransitionOutboxRow | undefined {
  return fixture.stateStore.sqlite
    .prepare(
      `SELECT transition_event_id, status, leased_at, delivered_at, attempts, last_error
         FROM transition_outbox
        WHERE transition_event_id = ?`
    )
    .get(transitionEventId) as TransitionOutboxRow | undefined
}

function countOutboxRows(fixture: TransitionOutboxFixture, transitionEventId: string): number {
  const row = fixture.stateStore.sqlite
    .prepare('SELECT COUNT(*) AS total FROM transition_outbox WHERE transition_event_id = ?')
    .get(transitionEventId) as { total: number }

  return row.total
}

function expectCoordinationProjection(fixture: TransitionOutboxFixture, taskId: string): void {
  const testerSessionRef = buildTesterSessionRef({
    testerAgentId: 'curly',
    projectId: fixture.seed.projectId,
    taskId,
  })
  const events = listEvents(fixture.coordStore, {
    projectId: fixture.seed.projectId,
    taskId,
  })
  const handoffs = listOpenHandoffs(fixture.coordStore, {
    projectId: fixture.seed.projectId,
    taskId,
  })
  const wakes = listPendingWakes(fixture.coordStore, {
    projectId: fixture.seed.projectId,
    sessionRef: testerSessionRef,
  })

  expect(events).toHaveLength(1)
  expect(events[0]?.kind).toBe('handoff.declared')
  expect(events[0]?.links?.taskId).toBe(taskId)
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0]?.taskId).toBe(taskId)
  expect(handoffs[0]?.kind).toBe('review')
  expect(wakes).toHaveLength(1)
  expect(wakes[0]?.sessionRef).toEqual(testerSessionRef)
  expect(wakes[0]?.state).toBe('queued')
  expect(handoffs[0]?.sourceEventId).toBe(events[0]?.eventId)
  expect(wakes[0]?.sourceEventId).toBe(events[0]?.eventId)
}

function createFailingCoordStore(message: string): CoordinationStore {
  return {
    sqlite: {
      query() {
        return {
          get() {
            return undefined
          },
        }
      },
      transaction() {
        return () => {
          throw new Error(message)
        }
      },
    },
    close() {},
  } as unknown as CoordinationStore
}

describe('transition outbox reconciler', () => {
  test('repairs crash between wrkq transition commit and outbox append by scanning history', async () => {
    await withTransitionOutboxFixture(async (fixture) => {
      createRedTask(fixture, 'T-43001')
      const transition = appendRedToGreenTransitionOnly(fixture, 'T-43001', 'TR-43001')
      const { reconcileTransitionOutbox } = await loadReconciler('scan-missing-row')

      expect(fixture.stateStore.transitionOutbox.get(transition.transitionEventId)).toBeUndefined()
      expect(
        listEvents(fixture.coordStore, { projectId: fixture.seed.projectId, taskId: 'T-43001' })
      ).toHaveLength(0)

      await reconcileTransitionOutbox({
        wrkqStore: fixture.wrkqStore,
        stateStore: fixture.stateStore,
        coordStore: fixture.coordStore,
      })

      expect(fixture.stateStore.transitionOutbox.get(transition.transitionEventId)?.status).toBe(
        'delivered'
      )
      expectCoordinationProjection(fixture, 'T-43001')
    })
  })

  test('drains pending outbox rows into coordination.db after a crash between outbox and coord append', async () => {
    await withTransitionOutboxFixture(async (fixture) => {
      createRedTask(fixture, 'T-43002')
      const transition = appendRedToGreenTransitionOnly(fixture, 'T-43002', 'TR-43002')
      appendOutboxRow(fixture, transition)
      const { reconcileTransitionOutbox } = await loadReconciler('drain-pending-row')

      await reconcileTransitionOutbox({
        wrkqStore: fixture.wrkqStore,
        stateStore: fixture.stateStore,
        coordStore: fixture.coordStore,
      })

      expect(readOutboxRow(fixture, 'TR-43002')?.status).toBe('delivered')
      expectCoordinationProjection(fixture, 'T-43002')
    })
  })

  test('treats repeated outbox appends for the same transition_event_id as idempotent', async () => {
    await withTransitionOutboxFixture(async (fixture) => {
      createRedTask(fixture, 'T-43003')
      const transition = appendRedToGreenTransitionOnly(fixture, 'T-43003', 'TR-43003')
      appendOutboxRow(fixture, transition)
      appendOutboxRow(fixture, transition)
      const { reconcileTransitionOutbox } = await loadReconciler('append-idempotent')

      expect(countOutboxRows(fixture, 'TR-43003')).toBe(1)

      await reconcileTransitionOutbox({
        wrkqStore: fixture.wrkqStore,
        stateStore: fixture.stateStore,
        coordStore: fixture.coordStore,
      })
      await reconcileTransitionOutbox({
        wrkqStore: fixture.wrkqStore,
        stateStore: fixture.stateStore,
        coordStore: fixture.coordStore,
      })

      expectCoordinationProjection(fixture, 'T-43003')
    })
  })

  test('records coord write failures on the outbox row and retries successfully on the next drain', async () => {
    await withTransitionOutboxFixture(async (fixture) => {
      createRedTask(fixture, 'T-43004')
      const transition = appendRedToGreenTransitionOnly(fixture, 'T-43004', 'TR-43004')
      appendOutboxRow(fixture, transition)
      const first = await loadReconciler('coord-failure-first-pass')

      await expect(
        first.reconcileTransitionOutbox({
          wrkqStore: fixture.wrkqStore,
          stateStore: fixture.stateStore,
          coordStore: createFailingCoordStore('coord append exploded'),
        })
      ).rejects.toThrow('coord append exploded')

      const failedRow = readOutboxRow(fixture, 'TR-43004')
      expect(failedRow?.status).toBe('leased')
      expect(failedRow?.attempts).toBe(1)
      expect(failedRow?.delivered_at).toBeNull()
      expect(failedRow?.last_error).toContain('coord append exploded')

      const second = await loadReconciler('coord-failure-second-pass')
      await second.reconcileTransitionOutbox({
        wrkqStore: fixture.wrkqStore,
        stateStore: fixture.stateStore,
        coordStore: fixture.coordStore,
      })

      const deliveredRow = readOutboxRow(fixture, 'TR-43004')
      expect(deliveredRow?.status).toBe('delivered')
      expect(deliveredRow?.attempts).toBe(2)
      expect(deliveredRow?.last_error).toBeNull()
      expect(deliveredRow?.delivered_at).not.toBeNull()
      expectCoordinationProjection(fixture, 'T-43004')
    })
  })

  test('is safe to call concurrently without double-delivering one transition_event_id', async () => {
    await withTransitionOutboxFixture(async (fixture) => {
      createRedTask(fixture, 'T-43005')
      const transition = appendRedToGreenTransitionOnly(fixture, 'T-43005', 'TR-43005')
      appendOutboxRow(fixture, transition)
      const { reconcileTransitionOutbox } = await loadReconciler('concurrent-drain')

      await Promise.all([
        reconcileTransitionOutbox({
          wrkqStore: fixture.wrkqStore,
          stateStore: fixture.stateStore,
          coordStore: fixture.coordStore,
        }),
        reconcileTransitionOutbox({
          wrkqStore: fixture.wrkqStore,
          stateStore: fixture.stateStore,
          coordStore: fixture.coordStore,
        }),
      ])

      expect(readOutboxRow(fixture, 'TR-43005')?.status).toBe('delivered')
      expectCoordinationProjection(fixture, 'T-43005')
    })
  })
})
