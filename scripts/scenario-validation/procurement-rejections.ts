import type { ActorRef, WorkflowDefinition } from '../../packages/acp-core/src/workflow/index.js'
import type { NegResult } from './contract.js'
import { createRejectionTask, findObligationByKind, publishKernel } from './kernel-fixture.js'

export function runProcurementChecks(workflow: WorkflowDefinition): NegResult[] {
  const out: NegResult[] = []
  const requester: ActorRef = { kind: 'human', id: 'alex' }
  const procurement: ActorRef = { kind: 'human', id: 'pat' }
  const legal: ActorRef = { kind: 'human', id: 'robin' }
  const sup = {
    actor: { kind: 'agent', id: 'rex' } as ActorRef,
    autonomy: 'managed' as const,
    capabilities: { satisfyObligations: true, createObligations: true, requestHumanInput: true },
  }

  // approver-cannot-be-requester: bind requester=procurement_lead=alex.
  {
    const k = publishKernel(workflow)
    const aliceBoth: ActorRef = { kind: 'human', id: 'alex' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-approver-eq-requester',
      risk: 'medium',
      roleBindings: { requester: aliceBoth, procurement_lead: aliceBoth, legal_reviewer: legal },
      supervisor: sup,
      idempotencyKey: 'neg-proc-aer:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: aliceBoth,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-aer:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: aliceBoth,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aer:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: aliceBoth,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aer:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-aer:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: legal,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aer:rl',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const lobl = findObligationByKind(k, task.taskId, 'legal_review_pending')
    const s2 = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: lobl.obligationId,
        evidence: [{ kind: 'legal_review', ref: 'd:l', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-aer:satl',
    })
    if (!s2.ok) throw new Error(s2.error.message)
    task = s2.task
    // complete_legal_review and approve both carry the same SoD requirement; whichever fires first is fine.
    const rcl = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'complete_legal_review',
      actor: aliceBoth,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aer:cl',
    })
    let firedAt = 'complete_legal_review'
    let firedCode: string = rcl.ok ? 'OK (no rejection)' : rcl.error.code
    if (rcl.ok) {
      task = rcl.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'approve',
        actor: aliceBoth,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'approval_record', ref: 'd:a', summary: 's' }],
        idempotencyKey: 'neg-proc-aer:approve',
      })
      firedAt = 'approve'
      firedCode = r3.ok ? 'OK (no rejection)' : r3.error.code
    }
    out.push({
      name: `approver-cannot-be-requester (asserted at ${firedAt} SoD)`,
      expected: 'sod_violation',
      got: firedCode,
      status: firedCode === 'sod_violation' ? 'pass' : 'fail',
    })
  }

  // approver-cannot-be-legal-reviewer: bind procurement_lead = legal_reviewer.
  {
    const k = publishKernel(workflow)
    const both: ActorRef = { kind: 'human', id: 'pat' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-aelr',
      risk: 'medium',
      roleBindings: { requester, procurement_lead: both, legal_reviewer: both },
      supervisor: sup,
      idempotencyKey: 'neg-proc-aelr:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-aelr:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: both,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aelr:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: both,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aelr:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-aelr:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    // resume_legal_review will itself reject because of SoD on resume_legal_review (legal_reviewer not same as procurement_lead).
    // For this check we want to verify approve's sod, so we pivot to using the explicit resume sod check below.
    // But ALSO, this binding pattern triggers `legal-reviewer-cannot-be-procurement-lead` at resume_legal_review.
    // For "approver-cannot-be-legal-reviewer", the kernel will reject earlier at resume_legal_review.
    // So we can only meaningfully assert sod_violation at resume_legal_review here, not at approve.
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: both,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-aelr:rl',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'approver-cannot-be-legal-reviewer (asserted at resume_legal_review SoD)',
      expected: 'sod_violation',
      got,
      status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
    })
  }

  // legal-reviewer-cannot-be-requester: bind requester = legal_reviewer.
  {
    const k = publishKernel(workflow)
    const both: ActorRef = { kind: 'human', id: 'alex' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-lrer',
      risk: 'medium',
      roleBindings: { requester: both, procurement_lead: procurement, legal_reviewer: both },
      supervisor: sup,
      idempotencyKey: 'neg-proc-lrer:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: both,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-lrer:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrer:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrer:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-lrer:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: both,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrer:rl',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'legal-reviewer-cannot-be-requester',
      expected: 'sod_violation',
      got,
      status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
    })
  }

  // legal-reviewer-cannot-be-procurement-lead: same as the aelr block above, count it again with explicit name.
  {
    const k = publishKernel(workflow)
    const both: ActorRef = { kind: 'human', id: 'pat' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-lrepl',
      risk: 'medium',
      roleBindings: { requester, procurement_lead: both, legal_reviewer: both },
      supervisor: sup,
      idempotencyKey: 'neg-proc-lrepl:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-lrepl:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: both,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrepl:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: both,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrepl:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-lrepl:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: both,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-lrepl:rl',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'legal-reviewer-cannot-be-procurement-lead',
      expected: 'sod_violation',
      got,
      status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
    })
  }

  // requester-actor-cannot-act-as-procurement-lead: at final_approval, attempt approve with actor=alex+role=procurement_lead.
  {
    const k = publishKernel(workflow)
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-racp',
      risk: 'medium',
      roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
      supervisor: sup,
      idempotencyKey: 'neg-proc-racp:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-racp:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-racp:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-racp:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-racp:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: legal,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-racp:rl',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const lobl = findObligationByKind(k, task.taskId, 'legal_review_pending')
    const s2 = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: lobl.obligationId,
        evidence: [{ kind: 'legal_review', ref: 'd:l', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-racp:satl',
    })
    if (!s2.ok) throw new Error(s2.error.message)
    task = s2.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'complete_legal_review',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-racp:cl',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    // Now attempt approve as alex (requester) claiming role=procurement_lead.
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'approve',
      actor: requester,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'approval_record', ref: 'd:a', summary: 's' }],
      idempotencyKey: 'neg-proc-racp:approve',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'requester-actor-cannot-act-as-procurement-lead',
      expected: 'role_not_bound',
      got,
      status: !r3.ok && r3.error.code === 'role_not_bound' ? 'pass' : 'fail',
    })
  }

  // resume-legal-review-without-vendor: skip step 06.
  {
    const k = publishKernel(workflow)
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-rlwv',
      risk: 'medium',
      roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
      supervisor: sup,
      idempotencyKey: 'neg-proc-rlwv:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-rlwv:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-rlwv:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-rlwv:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    // Skip satisfying vendor_response_pending; attempt resume_legal_review.
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: legal,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-rlwv:rl',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'resume-legal-review-without-vendor',
      expected: 'obligation_not_satisfied',
      got,
      status:
        !r3.ok &&
        (r3.error.code === 'obligation_not_satisfied' ||
          r3.error.code === 'open_blocking_obligation')
          ? 'pass'
          : 'fail',
    })
  }

  // complete-legal-without-legal-review: skip legal_review evidence + obligation satisfaction.
  {
    const k = publishKernel(workflow)
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-proc-clwlr',
      risk: 'medium',
      roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
      supervisor: sup,
      idempotencyKey: 'neg-proc-clwlr:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    let r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
      idempotencyKey: 'neg-proc-clwlr:submit',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'route_to_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-clwlr:route',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'wait_for_vendor',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-clwlr:wait',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
    const s = k.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'supv',
      capabilities: sup.capabilities,
      action: {
        type: 'satisfy_obligation',
        obligationId: vobl.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
      },
      idempotencyKey: 'neg-proc-clwlr:satv',
    })
    if (!s.ok) throw new Error(s.error.message)
    task = s.task
    r = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'resume_legal_review',
      actor: legal,
      role: 'legal_reviewer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-clwlr:rl',
    })
    if (!r.ok) throw new Error(r.error.message)
    task = r.task
    // Skip satisfying legal_review_pending. Attempt complete_legal_review.
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'complete_legal_review',
      actor: procurement,
      role: 'procurement_lead',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-proc-clwlr:cl',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'complete-legal-without-legal-review',
      expected: 'obligation_not_satisfied',
      got,
      status:
        !r3.ok &&
        (r3.error.code === 'obligation_not_satisfied' ||
          r3.error.code === 'open_blocking_obligation')
          ? 'pass'
          : 'fail',
    })
  }

  return out
}
