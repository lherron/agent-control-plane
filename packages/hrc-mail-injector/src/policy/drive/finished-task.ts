import { parseScopeRef } from 'agent-scope'

import type { MailKickerContext } from '../context.js'
import { errorText } from '../internal.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'
import type { ActionableEnvelope } from './presentation.js'

/** The task states wrkq itself treats as terminal. */
const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled', 'archived', 'deleted'])

/** A wrkq task id; a standing seat's task segment (`primary`, `minisvc`) is not one. */
const WRKQ_TASK_ID = /^T-\d+$/

function taskIdOf(scopeRef: string | undefined): string | undefined {
  if (scopeRef === undefined) return undefined
  let taskId: string | undefined
  try {
    taskId = parseScopeRef(scopeRef).taskId
  } catch {
    return undefined
  }
  return taskId !== undefined && WRKQ_TASK_ID.test(taskId) ? taskId : undefined
}

/**
 * An fyi-only wake for an absent seat whose task is finished starts no runtime
 * (T-12977, revisiting T-09643 for terminal tasks only).
 *
 * T-09643 lets a seat-absent fyi birth a runtime for an existing session so a
 * live target whose broker is down still gets the fyi on its next turn. A
 * completed or cancelled task has no next turn coming, so each fyi closes as
 * not delivered with a reason the sender can read. No failure notice follows:
 * an fyi carries no obligation (T-09880), so the sender is not woken.
 *
 * Returns how many envelopes were closed, or `undefined` when the caller must
 * keep T-09643 behaviour: not a task scope, the task is open, or the read
 * failed. A failed read never drops mail.
 */
export async function closeFyiForFinishedTask(
  server: MailKickerContext,
  input: {
    driveAttemptId: string
    targetSessionRef: string
    scopeRef: string | undefined
    actionable: readonly ActionableEnvelope[]
  }
): Promise<number | undefined> {
  const taskId = taskIdOf(input.scopeRef)
  if (taskId === undefined) return undefined
  let state: string
  try {
    state = (await server.ledger.taskShow({ task: taskId })).state
  } catch (error) {
    server.log('WARN', 'wrkq.kicker.target_task_state_read_failed', {
      driveAttemptId: input.driveAttemptId,
      targetSessionRef: input.targetSessionRef,
      taskId,
      error: errorText(error),
      fallback: 'deliver',
    })
    return undefined
  }
  if (!TERMINAL_TASK_STATES.has(state)) return undefined

  const detail = `target_task_terminal: ${taskId} is ${state}; a finished task's seat is not started for an fyi`
  server.log('INFO', 'wrkq.kicker.target_task_terminal', {
    driveAttemptId: input.driveAttemptId,
    targetSessionRef: input.targetSessionRef,
    taskId,
    taskState: state,
    envelopeIds: input.actionable.map((item) => item.envelope.id),
  })
  let closed = 0
  for (const item of input.actionable) {
    const result = await failEnvelopeWithAudit(server, {
      envelope: item.envelope.id,
      reason: 'undeliverable',
      detail,
      targetSessionRef: input.targetSessionRef,
      callSite: 'target_task_terminal',
    })
    if (result.outcome === 'failed') closed++
  }
  return closed
}
