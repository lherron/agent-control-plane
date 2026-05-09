import type { WorkflowDefinition } from '../../../../packages/acp-core/src/workflow/index.js'

export const basicWorkflowV1 = {
  id: 'basic',
  version: 1,
  kind: 'generic',
  initial: { status: 'open', phase: 'todo' },
  phases: {
    todo: {},
    doing: {},
  },
  outcomes: {
    success: {},
    cancelled: {},
    failed: {},
  },
  roles: {
    owner: { binding: 'autoBindOnFirstRun' },
  },
  evidenceKinds: {
    completion_note: { requiredFields: ['summary'] },
  },
  transitions: {
    start: {
      id: 'start',
      from: { status: 'open', phase: 'todo' },
      to: { status: 'active', phase: 'doing' },
      by: ['owner'],
    },
    close_success: {
      id: 'close_success',
      from: { status: 'active', phase: 'doing' },
      to: { status: 'closed', outcome: 'success' },
      by: ['owner'],
      requires: [{ type: 'evidence', kinds: ['completion_note'], mode: 'all' }],
    },
    cancel: {
      id: 'cancel',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'cancelled' },
      by: ['owner'],
      supervisorBypass: true,
    },
  },
} satisfies WorkflowDefinition

export const codeDefectFastlaneWorkflowV1 = {
  id: 'code_defect_fastlane',
  version: 1,
  kind: 'code_change',
  initial: { status: 'open', phase: 'red' },
  phases: {
    red: {},
    green: {},
    verified: {},
  },
  outcomes: {
    success: {},
    cancelled: {},
    failed: {},
  },
  roles: {
    implementer: { binding: 'required' },
    tester: { binding: 'optional', mustDifferFrom: ['implementer'] },
  },
  evidenceKinds: {
    failing_test: { requiredFields: ['ref'] },
    commit_ref: { requiredFields: ['ref'] },
    regression_test: { requiredFields: ['ref'] },
    verification_report: { requiredFields: ['summary'] },
    blocker_report: { requiredFields: ['summary'] },
  },
  obligationKinds: {
    missing_evidence: {
      blockingDefault: true,
      ownerRoles: ['implementer', 'tester'],
      allowedSatisfactionEvidence: ['commit_ref', 'regression_test', 'verification_report'],
    },
  },
  transitions: {
    start: {
      id: 'start',
      from: { status: 'open', phase: 'red' },
      to: { status: 'active', phase: 'red' },
      by: ['implementer'],
    },
    implement_fix: {
      id: 'implement_fix',
      from: { status: 'active', phase: 'red' },
      to: { status: 'active', phase: 'green' },
      by: ['implementer'],
      requires: [{ type: 'evidence', kinds: ['commit_ref', 'regression_test'], mode: 'all' }],
      effects: [
        {
          type: 'declare_handoff',
          toRole: 'tester',
          kind: 'review',
          when: [
            { type: 'risk_at_least', level: 'medium' },
            { type: 'role_bound', role: 'tester' },
          ],
        },
        {
          type: 'wake_role_session',
          role: 'tester',
          when: [
            { type: 'risk_at_least', level: 'medium' },
            { type: 'role_bound', role: 'tester' },
          ],
        },
      ],
    },
    verify: {
      id: 'verify',
      from: { status: 'active', phase: 'green' },
      to: { status: 'active', phase: 'verified' },
      by: ['tester'],
      requires: [
        { type: 'evidence', kinds: ['verification_report'], mode: 'all' },
        { type: 'sod', actingRole: 'tester', notSameAs: ['implementer'] },
      ],
    },
    close_success: {
      id: 'close_success',
      from: { status: 'active', phase: 'verified' },
      to: { status: 'closed', outcome: 'success' },
      by: ['implementer'],
    },
  },
  supervisor: {
    recovery: {
      onMissingEvidence: { prefer: ['create_obligation', 'launch_participant_run'] },
      onNoLegalTransition: { prefer: ['classify_anomaly', 'propose_workflow_patch'] },
    },
  },
} satisfies WorkflowDefinition

export const externalDependencyApprovalWorkflowV1 = {
  id: 'external_dependency_approval',
  version: 1,
  kind: 'approval',
  initial: { status: 'open', phase: 'request' },
  phases: {
    request: {},
    waiting_vendor: {},
    review: {},
    approved: {},
  },
  outcomes: {
    success: {},
    rejected: {},
    cancelled: {},
  },
  roles: {
    requester: { binding: 'required' },
    approver: { binding: 'required', mustDifferFrom: ['requester'] },
    vendor_proxy: { binding: 'optional' },
  },
  evidenceKinds: {
    request_packet: { requiredFields: ['summary'] },
    vendor_response: { requiredFields: ['summary'] },
    approval_record: { requiredFields: ['summary'] },
    legal_review: { requiredFields: ['summary'] },
  },
  obligationKinds: {
    vendor_response: {
      blockingDefault: true,
      ownerRoles: ['vendor_proxy'],
      allowedSatisfactionEvidence: ['vendor_response'],
    },
    legal_review: {
      blockingDefault: true,
      ownerRoles: ['approver'],
      allowedSatisfactionEvidence: ['legal_review'],
    },
  },
  transitions: {
    submit_request: {
      id: 'submit_request',
      from: { status: 'open', phase: 'request' },
      to: { status: 'active', phase: 'request' },
      by: ['requester'],
      requires: [{ type: 'evidence', kinds: ['request_packet'], mode: 'all' }],
    },
    wait_for_vendor: {
      id: 'wait_for_vendor',
      from: { status: 'active', phase: 'request' },
      to: { status: 'waiting', phase: 'waiting_vendor' },
      by: ['requester'],
      effects: [
        { type: 'create_obligation', kind: 'vendor_response', ownerRole: 'vendor_proxy' },
        { type: 'create_child_task', workflow: 'basic@1', relation: 'vendor-followup' },
      ],
    },
    resume_review: {
      id: 'resume_review',
      from: { status: 'waiting', phase: 'waiting_vendor' },
      to: { status: 'active', phase: 'review' },
      by: ['approver'],
      requires: [
        { type: 'obligation_satisfied', kind: 'vendor_response' },
        { type: 'evidence', kinds: ['vendor_response'], mode: 'all' },
      ],
    },
    approve: {
      id: 'approve',
      from: { status: 'active', phase: 'review' },
      to: { status: 'closed', outcome: 'success' },
      by: ['approver'],
      requires: [
        { type: 'evidence', kinds: ['approval_record'], mode: 'all' },
        { type: 'sod', actingRole: 'approver', notSameAs: ['requester'] },
      ],
    },
  },
} satisfies WorkflowDefinition

export const workflowFixtures = [
  basicWorkflowV1,
  codeDefectFastlaneWorkflowV1,
  externalDependencyApprovalWorkflowV1,
] as const
