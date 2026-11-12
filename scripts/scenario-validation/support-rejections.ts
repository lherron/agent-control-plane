import type { ActorRef, WorkflowDefinition } from '../../packages/acp-core/src/workflow/index.js'
import type { NegResult } from './contract.js'
import { createRejectionTask, publishKernel } from './kernel-fixture.js'

export function runSupportChecks(workflow: WorkflowDefinition): NegResult[] {
  const out: NegResult[] = []
  // resume-without-obligation: skip step 07, attempt resume_resolution from waiting.
  {
    const k = publishKernel(workflow)
    const supportActor: ActorRef = { kind: 'human', id: 'morgan' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-supp-1',
      risk: 'low',
      roleBindings: { support_agent: supportActor },
      idempotencyKey: 'neg-supp-1:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    const r1 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'start_triage',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'triage_summary', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-supp-1:start',
    })
    if (!r1.ok) throw new Error(r1.error.message)
    task = r1.task
    const r2 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'reach_out',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'customer_outreach_record', ref: 'e:1' }],
      idempotencyKey: 'neg-supp-1:reach',
    })
    if (!r2.ok) throw new Error(r2.error.message)
    task = r2.task
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_customer',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-supp-1:wait',
    })
    if (!r3.ok) throw new Error(r3.error.message)
    task = r3.task
    // Skip satisfy_obligation. Try resume_resolution directly.
    const r4 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_resolution',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-supp-1:resume',
    })
    const got = r4.ok ? 'OK (no rejection)' : r4.error.code
    out.push({
      name: 'resume-without-obligation',
      expected: 'obligation_not_satisfied',
      got,
      status: !r4.ok && r4.error.code === 'obligation_not_satisfied' ? 'pass' : 'fail',
    })
  }
  // wait-prevents-direct-resolve: from waiting attempt resolve.
  {
    const k = publishKernel(workflow)
    const supportActor: ActorRef = { kind: 'human', id: 'morgan' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-supp-2',
      risk: 'low',
      roleBindings: { support_agent: supportActor },
      idempotencyKey: 'neg-supp-2:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'start_triage',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'triage_summary', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-supp-2:start',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'reach_out',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'customer_outreach_record', ref: 'e:1' }],
      idempotencyKey: 'neg-supp-2:reach',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_customer',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-supp-2:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const r2 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resolve',
      actor: supportActor,
      role: 'support_agent',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-supp-2:resolve',
    })
    const got = r2.ok ? 'OK (no rejection)' : r2.error.code
    out.push({
      name: 'wait-prevents-direct-resolve',
      expected: 'state_mismatch',
      got,
      status: !r2.ok && r2.error.code === 'state_mismatch' ? 'pass' : 'fail',
    })
  }

  return out
}
