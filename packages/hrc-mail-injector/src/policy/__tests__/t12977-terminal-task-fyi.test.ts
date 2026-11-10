/**
 * A seat-absent fyi to a FINISHED task's seat starts no runtime (T-12977).
 *
 * T-09643 lets a seat-absent fyi birth a runtime for an existing session, so a
 * live target whose broker is down still gets the fyi on its next turn. A
 * completed or cancelled task has no next turn coming. Starting its seat just to
 * show it an fyi is what woke four finished seats into removed worktrees
 * (T-11101, T-11929, T-12620, T-12976). The fyi closes as not delivered, naming
 * `target_task_terminal`; the sender, owed nothing, is not woken.
 *
 * Each case is paired with the control that keeps T-09643 for live targets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { closeFyiForFinishedTask } from '../drive/finished-task.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import {
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const TASK = 'T-08094'
let h: T08094Harness

beforeEach(async () => {
  h = await createT08094Harness()
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function doors(): unknown[] {
  return h.logs
    .filter((entry) => entry.event === 'wrkq.kicker.delivery_intent')
    .map((entry) => (entry.detail as Record<string, unknown>)['door'])
}

describe('T-12977 — an fyi never starts a finished task seat', () => {
  for (const state of ['completed', 'cancelled']) {
    it(`closes the fyi once, starting nothing, when the task is ${state}`, async () => {
      h.ledger.taskStates.set(TASK, state)
      const fyi = h.ledger.say({ obligation: 'fyi' })

      expect(await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')).toMatchObject({
        outcome: 'undeliverable',
        failed: 1,
      })
      expect(doors()).toEqual([])
      expect(h.dispatches).toHaveLength(0)
      expect(h.ledger.failRequests).toHaveLength(1)
      const [failed] = h.ledger.failRequests
      expect(failed).toMatchObject({ envelope: fyi.id, reason: 'undeliverable' })
      expect(failed?.detail).toContain('target_task_terminal')
      expect(failed?.detail).toContain(TASK)
      expect(failed?.detail).toContain(state)
      expect(h.ledger.taskShowRequests).toEqual([TASK])
      // The sender is owed nothing for an fyi, so nothing is woken for it.
      expect(h.wakes).toEqual([])

      // The next periodic wake has nothing to drive.
      expect(await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')).toEqual({
        outcome: 'empty',
      })
      expect(h.dispatches).toHaveLength(0)
      expect(h.ledger.failRequests).toHaveLength(1)
      expect(h.ledger.taskShowRequests).toEqual([TASK])
    })
  }

  it('CONTROL: a reply_required to a completed task seat still takes the launch door', async () => {
    h.ledger.taskStates.set(TASK, 'completed')
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(doors()).toEqual(['launch'])
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.taskShowRequests).toEqual([])
  })

  it('CONTROL: an open task seat still gets its fyi through the ordinary door (T-09643)', async () => {
    h.ledger.say({ obligation: 'fyi' })
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')

    expect(doors()).toEqual(['enqueue'])
    expect(h.dispatches).toHaveLength(1)
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.ledger.taskShowRequests).toEqual([TASK])
  })

  it('delivers as before, and says so, when the task read fails', async () => {
    h.ledger.taskShowError = new Error('wrkq unreachable')
    h.ledger.say({ obligation: 'fyi' })
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')

    expect(doors()).toEqual(['enqueue'])
    expect(h.ledger.failRequests).toHaveLength(0)
    expect(
      h.logs.find((entry) => entry.event === 'wrkq.kicker.target_task_state_read_failed')
    ).toMatchObject({ level: 'WARN', detail: { taskId: TASK } })
  })

  // A standing seat (`…:task:primary`, `minisvc`) names no wrkq task: it keeps
  // T-09643 without a refused read or a warning.
  for (const lane of ['primary', 'minisvc']) {
    it(`reads no task and warns nothing for a standing seat (${lane})`, async () => {
      const fyi = h.ledger.say({ obligation: 'fyi' })
      const closed = await closeFyiForFinishedTask(h.context, {
        driveAttemptId: 'drive-standing',
        targetSessionRef: `agent:clod:project:hrc-runtime:task:${lane}/lane:main`,
        scopeRef: `agent:clod:project:hrc-runtime:task:${lane}`,
        actionable: [{ envelope: fyi, form: 'full' } as never],
      })

      expect(closed).toBeUndefined()
      expect(h.ledger.taskShowRequests).toEqual([])
      expect(h.logs.filter((entry) => entry.level === 'WARN')).toEqual([])
    })
  }

  it('CONTROL: a T- task scope still reads its task', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    await closeFyiForFinishedTask(h.context, {
      driveAttemptId: 'drive-task',
      targetSessionRef: TARGET_REF,
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-08094',
      actionable: [{ envelope: fyi, form: 'full' } as never],
    })
    expect(h.ledger.taskShowRequests).toEqual([TASK])
  })
})
