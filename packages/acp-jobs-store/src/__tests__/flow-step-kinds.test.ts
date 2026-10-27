/**
 * T-04942 Phase A — RED tests.
 *
 * Covers:
 *   #1  Admin/job flow validation: event-triggered flow accepted only with
 *       guarded authority surface; generic event payload interpolation into
 *       authority fields is rejected fail-closed.
 *   #4  Step-output ref validation: $step to a non-existent / later step id,
 *       or a nested/dotted field name, fails validation.
 *   #8  Safety regressions: exec remains argv-only; existing resolveEventAction
 *       generic-payload structural-deny invariants continue to pass.
 *
 * All tests marked "RED" assert behaviour the current validator does NOT yet
 * produce — they FAIL now and must PASS after Phase A implementation.
 * Tests marked "REGRESSION" assert invariants that already hold and must
 * continue to hold after implementation.
 *
 * Do NOT add implementation logic to this file — it is a pure test harness.
 */
import { describe, expect, test } from 'bun:test'

import { validateJobFlow } from '../flow-validation.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function expectCodes(
  result: ReturnType<typeof validateJobFlow>,
  codes: readonly JobFlowValidationErrorCode[]
): void {
  expect(result.valid).toBe(false)
  if (!result.valid) {
    const actual = result.errors.map((e) => e.code)
    expect(actual).toEqual(expect.arrayContaining(codes))
  }
}

function expectError(
  result: ReturnType<typeof validateJobFlow>,
  expected: { code: JobFlowValidationErrorCode; path: string }
): void {
  expect(result.valid).toBe(false)
  if (!result.valid) {
    expect(result.errors).toContainEqual(expect.objectContaining(expected))
  }
}

// Import the error-code type so TypeScript checks new codes are in the union.
import type { JobFlowValidationErrorCode } from '../flow-validation.js'

// ─────────────────────────────────────────────────────────────────────────────
// Group A — wrkq-task step kind
// RED: currently rejected with invalid_step_kind
// ─────────────────────────────────────────────────────────────────────────────

describe('wrkq-task step kind (Phase A — RED)', () => {
  test('accepts wrkq-task with literal title and container', () => {
    // RED: current code produces invalid_step_kind
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create',
            kind: 'wrkq-task',
            title: 'Investigate the widget',
            container: 'agent-control-plane/inbox',
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('accepts wrkq-task with optional description and labels', () => {
    // RED: same
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create',
            kind: 'wrkq-task',
            title: 'Investigate the widget',
            container: 'agent-control-plane/inbox',
            description: 'Do the research.',
            taskKind: 'task',
            labels: ['feature', 'alpha'],
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test.each([
    ['title', { id: 'create', kind: 'wrkq-task', container: 'agent-control-plane/inbox' }],
    ['container', { id: 'create', kind: 'wrkq-task', title: 'A task' }],
  ])('rejects wrkq-task missing required %s with an error at that field', (field, step) => {
    expectError(validateJobFlow({ sequence: [step] }), {
      code: 'invalid_wrkq_task_step',
      path: `flow.sequence[0].${field}`,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group B — pulpit-message step kind
// RED: currently rejected with invalid_step_kind
// ─────────────────────────────────────────────────────────────────────────────

describe('pulpit-message step kind (Phase A — RED)', () => {
  test('accepts pulpit-message with literal content and binding', () => {
    // RED
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'notify',
            kind: 'pulpit-message',
            content: 'Task created.',
            binding: 'discord:primary',
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test.each([
    ['binding', { id: 'notify', kind: 'pulpit-message', content: 'Hello world.' }],
    ['content', { id: 'notify', kind: 'pulpit-message', binding: 'discord:primary' }],
  ])('rejects pulpit-message missing required %s with an error at that field', (field, step) => {
    expectError(validateJobFlow({ sequence: [step] }), {
      code: 'invalid_pulpit_message_step',
      path: `flow.sequence[0].${field}`,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group C — agent-dispatch step kind
// RED: currently rejected with invalid_step_kind
// ─────────────────────────────────────────────────────────────────────────────

describe('agent-dispatch step kind (Phase A — RED)', () => {
  test('accepts agent-dispatch with literal scopeRef and optional input', () => {
    // RED
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
            input: { content: 'Do the work.' },
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('accepts agent-dispatch with explicit laneRef', () => {
    // RED
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
            laneRef: 'repair',
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('rejects agent-dispatch missing required scopeRef with an error at scopeRef', () => {
    expectError(
      validateJobFlow({
        sequence: [{ id: 'dispatch', kind: 'agent-dispatch', input: { content: 'x' } }],
      }),
      { code: 'invalid_agent_dispatch_step', path: 'flow.sequence[0].scopeRef' }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group D — multi-step flows combining new step kinds
// RED: both step kinds currently rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('multi-step flows with new step kinds (Phase A — RED)', () => {
  test('accepts two-step flow: wrkq-task then agent-dispatch', () => {
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create_task',
            kind: 'wrkq-task',
            title: 'Feature work',
            container: 'agent-control-plane/inbox',
          },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
            input: { content: 'Implement the feature.' },
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('accepts wrkq-task + pulpit-message notification in onFailure', () => {
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create_task',
            kind: 'wrkq-task',
            title: 'Feature work',
            container: 'agent-control-plane/inbox',
          },
        ],
        onFailure: [
          {
            id: 'alert',
            kind: 'pulpit-message',
            content: 'Task creation failed.',
            binding: 'discord:primary',
          },
        ],
      })
    ).toEqual({ valid: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group E — step-output ref validation  (test #4)
// RED: step-output ref validation doesn't exist yet
// ─────────────────────────────────────────────────────────────────────────────

describe('step-output ref validation (Phase A — RED — test #4)', () => {
  test('accepts step-output ref to a prior step in an authority field', () => {
    // RED: step kinds not recognized yet; after Phase A this should be valid
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create_task',
            kind: 'wrkq-task',
            title: 'New task',
            container: 'agent-control-plane/inbox',
          },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            // step-output ref: use the scope ref produced by create_task
            scopeRef: { $step: 'create_task', field: 'assignedScopeRef' },
            input: { content: 'Handle the task.' },
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('rejects step-output ref to a non-existent step id', () => {
    // RED: no such validation exists — currently fails first on invalid_step_kind
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: { $step: 'nonexistent_step', field: 'assignedScopeRef' },
            input: { content: 'x' },
          },
        ],
      }),
      ['step_output_ref_unknown_step']
    )
  })

  test('rejects step-output ref to a later step (forward reference)', () => {
    // RED: forward refs must be rejected — create_task comes AFTER dispatch here
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: { $step: 'create_task', field: 'assignedScopeRef' },
            input: { content: 'x' },
          },
          { id: 'create_task', kind: 'wrkq-task', title: 'New task', container: 'inbox' },
        ],
      }),
      ['step_output_ref_unknown_step']
    )
  })

  test.each([
    ['dotted field', { $step: 'create', field: 'nested.scopeRef' }],
    ['bracket field', { $step: 'create', field: 'arr[0]' }],
    ['missing $step', { field: 'assignedScopeRef' }],
    ['missing field', { $step: 'create' }],
  ])(
    'rejects a malformed step-output ref (%s) with invalid_step_output_ref',
    (_label, scopeRef) => {
      expectError(
        validateJobFlow({
          sequence: [
            { id: 'create', kind: 'wrkq-task', title: 'x', container: 'inbox' },
            { id: 'dispatch', kind: 'agent-dispatch', scopeRef, input: { content: 'x' } },
          ],
        }),
        { code: 'invalid_step_output_ref', path: 'flow.sequence[1].scopeRef' }
      )
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Group F — authority field guard  (test #1)
// RED: authority guard not implemented — currently rejected first with invalid_step_kind
// ─────────────────────────────────────────────────────────────────────────────

describe('authority field guard — template strings rejected (Phase A — RED — test #1)', () => {
  // wrkq-task: container is an authority field
  test('rejects wrkq-task with template string in container', () => {
    // RED: authority guard must reject {{…}} in container
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'create',
            kind: 'wrkq-task',
            title: 'New task',
            container: '{{payload.project}}/inbox',
          },
        ],
      }),
      ['authority_field_interpolation']
    )
  })

  test.each([
    [
      'wrkq-task title',
      {
        id: 'create',
        kind: 'wrkq-task',
        title: 'Task from event: {{title}}',
        container: 'agent-control-plane/inbox',
      },
    ],
    [
      'wrkq-task description',
      {
        id: 'create',
        kind: 'wrkq-task',
        title: 'Incident task',
        container: 'agent-control-plane/inbox',
        description: 'Triggered by event {{event}} on {{subject_id}}.',
      },
    ],
    [
      'pulpit-message content',
      {
        id: 'notify',
        kind: 'pulpit-message',
        content: 'Task {{payload.ticket_id}} created by {{origin_actor}}.',
        binding: 'discord:primary',
      },
    ],
    [
      'agent-dispatch input content',
      {
        id: 'dispatch',
        kind: 'agent-dispatch',
        scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
        input: { content: 'Process event {{event}} for task {{payload.ticket_id}}.' },
      },
    ],
  ])('accepts a template string in a content field (%s)', (_label, step) => {
    expect(validateJobFlow({ sequence: [step] })).toEqual({ valid: true })
  })

  // pulpit-message: binding is an authority field
  test('rejects pulpit-message with template string in binding', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'notify',
            kind: 'pulpit-message',
            content: 'Hello.',
            binding: '{{payload.channel}}',
          },
        ],
      }),
      ['authority_field_interpolation']
    )
  })

  // agent-dispatch: scopeRef and laneRef are authority fields
  test('rejects agent-dispatch with template string in scopeRef', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:{{payload.project}}:task:primary',
            input: { content: 'x' },
          },
        ],
      }),
      ['authority_field_interpolation']
    )
  })

  test('rejects agent-dispatch with template string in laneRef', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
            laneRef: '{{payload.lane}}',
            input: { content: 'x' },
          },
        ],
      }),
      ['authority_field_interpolation']
    )
  })

  test('accepts all new step kinds with step-output refs in authority fields', () => {
    // RED: step-output refs ARE allowed in authority fields (the trusted alternative to literals)
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create_task',
            kind: 'wrkq-task',
            title: 'New task from event',
            container: 'agent-control-plane/inbox',
          },
          {
            id: 'notify',
            kind: 'pulpit-message',
            content: 'Task created.',
            binding: { $step: 'create_task', field: 'interfaceBinding' },
          },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: { $step: 'create_task', field: 'assignedScopeRef' },
            input: { content: 'Work on the task.' },
          },
        ],
      })
    ).toEqual({ valid: true })
  })
})
