import type { ActorRef, WorkflowDefinition } from '../../packages/acp-core/src/workflow/index.js'
import type { NegResult } from './contract.js'
import { createRejectionTask, publishKernel } from './kernel-fixture.js'

export function runHotfixChecks(workflow: WorkflowDefinition): NegResult[] {
  const out: NegResult[] = []
  // implementer-actor-cannot-act-as-tester: drive to green, then verify with role=tester but actor=implementer.
  {
    const k = publishKernel(workflow)
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-hotfix-1',
      risk: 'medium',
      roleBindings: {
        implementer: { kind: 'agent', id: 'clod' },
        tester: { kind: 'agent', id: 'cody' },
      },
      idempotencyKey: 'neg-hotfix-1:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    const r1 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: { kind: 'agent', id: 'clod' },
      role: 'implementer',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
      idempotencyKey: 'neg-hotfix-1:start',
    })
    if (!r1.ok) throw new Error(r1.error.message)
    task = r1.task
    const r2 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: { kind: 'agent', id: 'clod' },
      role: 'implementer',
      expectedTaskVersion: task.version,
      inlineEvidence: [
        { kind: 'commit_ref', ref: 'git:x' },
        { kind: 'regression_test', ref: 'test:x' },
      ],
      idempotencyKey: 'neg-hotfix-1:fix',
    })
    if (!r2.ok) throw new Error(r2.error.message)
    task = r2.task
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'verify',
      actor: { kind: 'agent', id: 'clod' },
      role: 'tester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'verification_report', ref: 'r:x', summary: 's' }],
      idempotencyKey: 'neg-hotfix-1:verify',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'implementer-actor-cannot-act-as-tester',
      expected: 'role_not_bound',
      got,
      status: !r3.ok && r3.error.code === 'role_not_bound' ? 'pass' : 'fail',
    })
  }
  // sod-same-actor-both-roles: bind same actor to both, reach green, try verify.
  {
    const k = publishKernel(workflow)
    const sameActor: ActorRef = { kind: 'agent', id: 'clod' }
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-hotfix-2',
      risk: 'medium',
      roleBindings: { implementer: sameActor, tester: sameActor },
      idempotencyKey: 'neg-hotfix-2:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    const r1 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: sameActor,
      role: 'implementer',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
      idempotencyKey: 'neg-hotfix-2:start',
    })
    if (!r1.ok) throw new Error(r1.error.message)
    task = r1.task
    const r2 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: sameActor,
      role: 'implementer',
      expectedTaskVersion: task.version,
      inlineEvidence: [
        { kind: 'commit_ref', ref: 'git:x' },
        { kind: 'regression_test', ref: 'test:x' },
      ],
      idempotencyKey: 'neg-hotfix-2:fix',
    })
    if (!r2.ok) throw new Error(r2.error.message)
    task = r2.task
    const r3 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'verify',
      actor: sameActor,
      role: 'tester',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'verification_report', ref: 'r:x', summary: 's' }],
      idempotencyKey: 'neg-hotfix-2:verify',
    })
    const got = r3.ok ? 'OK (no rejection)' : r3.error.code
    out.push({
      name: 'sod-same-actor-both-roles',
      expected: 'sod_violation',
      got,
      status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
    })
  }
  // missing-evidence-blocks-fix: skip step 04, try implement_fix.
  {
    const k = publishKernel(workflow)
    const created = createRejectionTask(k, workflow, {
      taskId: 'neg-hotfix-3',
      risk: 'medium',
      roleBindings: {
        implementer: { kind: 'agent', id: 'clod' },
        tester: { kind: 'agent', id: 'cody' },
      },
      idempotencyKey: 'neg-hotfix-3:create',
    })
    if (!created.ok) throw new Error(created.error.message)
    let task = created.task
    const r1 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: { kind: 'agent', id: 'clod' },
      role: 'implementer',
      expectedTaskVersion: task.version,
      inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
      idempotencyKey: 'neg-hotfix-3:start',
    })
    if (!r1.ok) throw new Error(r1.error.message)
    task = r1.task
    const r2 = k.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: { kind: 'agent', id: 'clod' },
      role: 'implementer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'neg-hotfix-3:fix',
    })
    const got = r2.ok ? 'OK (no rejection)' : r2.error.code
    out.push({
      name: 'missing-evidence-blocks-fix',
      expected: 'missing_evidence',
      got,
      status: !r2.ok && r2.error.code === 'missing_evidence' ? 'pass' : 'fail',
    })
  }

  return out
}
