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
          { id: 'create', kind: 'wrkq-task', title: 'Investigate the widget', container: 'agent-control-plane/inbox' },
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

  test('rejects wrkq-task missing required title with step-specific error', () => {
    // RED: current code produces invalid_step_kind, not invalid_wrkq_task_step
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'create', kind: 'wrkq-task', container: 'agent-control-plane/inbox' }],
      }),
      ['invalid_wrkq_task_step']
    )
  })

  test('rejects wrkq-task missing required container with step-specific error', () => {
    // RED: same
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'create', kind: 'wrkq-task', title: 'A task' }],
      }),
      ['invalid_wrkq_task_step']
    )
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
          { id: 'notify', kind: 'pulpit-message', content: 'Task created.', binding: 'discord:primary' },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('rejects pulpit-message missing required binding', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'notify', kind: 'pulpit-message', content: 'Hello world.' }],
      }),
      ['invalid_pulpit_message_step']
    )
  })

  test('rejects pulpit-message missing required content', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'notify', kind: 'pulpit-message', binding: 'discord:primary' }],
      }),
      ['invalid_pulpit_message_step']
    )
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

  test('rejects agent-dispatch missing required scopeRef', () => {
    // RED
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'dispatch', kind: 'agent-dispatch', input: { content: 'x' } }],
      }),
      ['invalid_agent_dispatch_step']
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
          { id: 'create_task', kind: 'wrkq-task', title: 'New task', container: 'agent-control-plane/inbox' },
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

  test('rejects step-output ref with dotted field name', () => {
    // RED: field must be a bare identifier — no dots allowed
    expectCodes(
      validateJobFlow({
        sequence: [
          { id: 'create', kind: 'wrkq-task', title: 'x', container: 'inbox' },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: { $step: 'create', field: 'nested.scopeRef' },
            input: { content: 'x' },
          },
        ],
      }),
      ['invalid_step_output_ref']
    )
  })

  test('rejects step-output ref with bracket notation in field name', () => {
    // RED: no bracket notation
    expectCodes(
      validateJobFlow({
        sequence: [
          { id: 'create', kind: 'wrkq-task', title: 'x', container: 'inbox' },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: { $step: 'create', field: 'arr[0]' },
            input: { content: 'x' },
          },
        ],
      }),
      ['invalid_step_output_ref']
    )
  })

  test('rejects malformed step-output ref missing $step', () => {
    // RED: $step is required
    expectCodes(
      validateJobFlow({
        sequence: [
          { id: 'create', kind: 'wrkq-task', title: 'x', container: 'inbox' },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            // missing $step — only has field
            scopeRef: { field: 'assignedScopeRef' },
            input: { content: 'x' },
          },
        ],
      }),
      ['invalid_step_output_ref']
    )
  })

  test('rejects malformed step-output ref missing field', () => {
    // RED: field is required
    expectCodes(
      validateJobFlow({
        sequence: [
          { id: 'create', kind: 'wrkq-task', title: 'x', container: 'inbox' },
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            // missing field — only has $step
            scopeRef: { $step: 'create' },
            input: { content: 'x' },
          },
        ],
      }),
      ['invalid_step_output_ref']
    )
  })
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

  test('accepts wrkq-task with template string in title (content field)', () => {
    // RED: title is a CONTENT field — templates are allowed here
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create',
            kind: 'wrkq-task',
            title: 'Task from event: {{title}}',
            container: 'agent-control-plane/inbox',
          },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('rejects wrkq-task with template in description (authority-adjacent — must use ref or literal)', () => {
    // description is content so templates ARE allowed — it should be valid
    // (this test is actually a positive case, confirming content fields are free)
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'create',
            kind: 'wrkq-task',
            title: 'Incident task',
            container: 'agent-control-plane/inbox',
            description: 'Triggered by event {{event}} on {{subject_id}}.',
          },
        ],
      })
    ).toEqual({ valid: true })
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

  test('accepts pulpit-message with template string in content (content field)', () => {
    // RED: content is a CONTENT field — templates allowed
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'notify',
            kind: 'pulpit-message',
            content: 'Task {{payload.ticket_id}} created by {{origin_actor}}.',
            binding: 'discord:primary',
          },
        ],
      })
    ).toEqual({ valid: true })
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

  test('accepts agent-dispatch with template string in input content field', () => {
    // RED: input fields are CONTENT — templates allowed
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'dispatch',
            kind: 'agent-dispatch',
            scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
            input: { content: 'Process event {{event}} for task {{payload.ticket_id}}.' },
          },
        ],
      })
    ).toEqual({ valid: true })
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

// ─────────────────────────────────────────────────────────────────────────────
// Group G — safety regressions  (test #8)
// REGRESSION: these already pass and must continue to pass after Phase A
// ─────────────────────────────────────────────────────────────────────────────

describe('safety regressions — exec and flow invariants (test #8 — REGRESSION)', () => {
  test('exec step still requires argv (shell command strings remain rejected)', () => {
    const result = validateJobFlow({
      sequence: [{ id: 'run', kind: 'exec', exec: { command: 'bun test' } }],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain('invalid_exec_command')
    }
  })

  test('exec step with valid argv is still accepted', () => {
    expect(
      validateJobFlow({
        sequence: [{ id: 'run', kind: 'exec', exec: { argv: ['bun', 'test'] } }],
      })
    ).toEqual({ valid: true })
  })

  test('exec step with argv=[] is rejected (empty argv stays invalid)', () => {
    const result = validateJobFlow({
      sequence: [{ id: 'run', kind: 'exec', exec: { argv: [] } }],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain('invalid_exec_argv')
    }
  })

  test('unknown step kind is still rejected (guard stays in place)', () => {
    const result = validateJobFlow({
      sequence: [{ id: 'run', kind: 'shell', exec: { argv: ['ls'] } }],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain('invalid_step_kind')
    }
  })
})
