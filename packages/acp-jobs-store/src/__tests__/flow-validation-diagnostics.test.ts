import { expect, test } from 'bun:test'

import {
  formatJobFlowValidationErrors,
  validateJobFlow,
  validateJobFlowJob,
} from '../flow-validation.js'

test.each([
  [undefined, 'invalid_probe_step', 'branches.outcome', 'probe step must include branches.outcome'],
  [null, 'invalid_flow_next', 'branches', 'branches must be an object'],
  [
    { exitCode: { '0': 'missing' }, default: 1 },
    'invalid_probe_step',
    'branches.exitCode',
    'probe steps must branch on outcome, not exitCode',
  ],
  [
    { outcome: null },
    'invalid_probe_step',
    'branches.outcome',
    'branches.outcome must be an object',
  ],
] as const)(
  'preserves probe branch short-circuit diagnostics for %j',
  (branches, code, suffix, message) => {
    const result = validateJobFlow({
      sequence: [
        {
          id: 'gate',
          kind: 'probe',
          probe: { name: 'hrc-event-local-node.v1' },
          ...(branches === undefined ? {} : { branches }),
        },
      ],
    })
    const errors = [{ code, path: `flow.sequence[0].${suffix}`, message }]
    // Target validation still follows shape validation even when shape validation returns early.
    if (branches && 'exitCode' in branches) {
      errors.push({
        code: 'invalid_flow_next',
        path: 'flow.sequence[0].branches.exitCode.0',
        message: 'flow target must be continue, succeed, fail, or a step id in the same phase',
      })
    }
    expect(result).toEqual({ valid: false, errors })
  }
)

test('retains shape errors before target errors and suppresses cycle checks after errors', () => {
  expect(
    validateJobFlow({
      sequence: [
        {
          id: 'run',
          kind: 'exec',
          exec: { argv: ['true'] },
          next: 'run',
          branches: { exitCode: { '-1': false }, outcome: { strange: 'missing' }, default: 1 },
        },
      ],
    })
  ).toEqual({
    valid: false,
    errors: [
      {
        code: 'invalid_branch_exit_code',
        path: 'flow.sequence[0].branches.exitCode.-1',
        message: 'branch exit codes must be integer strings from 0 to 255',
      },
      {
        code: 'invalid_flow_next',
        path: 'flow.sequence[0].branches.exitCode.-1',
        message: 'branch target must be a terminal token or step id',
      },
      {
        code: 'invalid_flow_next',
        path: 'flow.sequence[0].branches.outcome',
        message: 'outcome branches are only supported on probe steps',
      },
      {
        code: 'invalid_flow_next',
        path: 'flow.sequence[0].branches.outcome.strange',
        message: 'flow target must be continue, succeed, fail, or a step id in the same phase',
      },
    ],
  })
})

test('malformed reference objects produce reference errors without extra missing-field errors', () => {
  expect(
    validateJobFlow({
      sequence: [
        {
          id: 'send',
          kind: 'agent-dispatch',
          scopeRef: { $step: 'later', field: 'nested.value' },
          agentId: { $step: 'later', field: 'id' },
          projectId: '',
          laneRef: '{{payload.lane}}',
          input: { content: { $step: 'send', field: 'id' } },
        },
      ],
    })
  ).toEqual({
    valid: false,
    errors: [
      {
        code: 'invalid_step_output_ref',
        path: 'flow.sequence[0].scopeRef',
        message: 'step-output ref must be an object with non-empty $step and top-level field',
      },
      {
        code: 'step_output_ref_unknown_step',
        path: 'flow.sequence[0].agentId.$step',
        message: 'step-output ref must name a prior step in the same phase',
      },
      {
        code: 'invalid_agent_dispatch_step',
        path: 'flow.sequence[0].projectId',
        message: 'agent-dispatch projectId must be a non-empty string or step-output ref',
      },
      {
        code: 'authority_field_interpolation',
        path: 'flow.sequence[0].laneRef',
        message:
          'authority fields must use literal values or step-output refs, not template interpolation',
      },
      {
        code: 'step_output_ref_unknown_step',
        path: 'flow.sequence[0].input.content.$step',
        message: 'step-output ref must name a prior step in the same phase',
      },
    ],
  })
})

test('keeps cron, step, graph and trigger-context diagnostics in order and formats them verbatim', () => {
  const result = validateJobFlowJob({
    schedule: { cron: 'invalid' },
    triggerKind: 'event',
    flow: { sequence: [{ id: 'work', input: 'x', freshDuration: 'bad', next: 'missing' }] },
  })
  expect(result).toEqual({
    valid: false,
    errors: [
      { code: 'invalid_cron', path: 'schedule.cron', message: 'invalid cron schedule: invalid' },
      {
        code: 'invalid_fresh_duration',
        path: 'flow.sequence[0].freshDuration',
        message: 'freshDuration requires fresh=true',
      },
      {
        code: 'invalid_fresh_duration',
        path: 'flow.sequence[0].freshDuration',
        message: 'freshDuration must be a positive fixed ISO 8601 duration using D, H, M, or S',
      },
      {
        code: 'invalid_flow_next',
        path: 'flow.sequence[0].next',
        message: 'flow target must be continue, succeed, fail, or a step id in the same phase',
      },
      {
        code: 'invalid_fresh_duration',
        path: 'flow.sequence[0].freshDuration',
        message: 'freshDuration is only supported for scheduled flow jobs',
      },
    ],
  })
  if (!result.valid) {
    expect(formatJobFlowValidationErrors(result.errors)).toBe(
      'invalid_cron at schedule.cron: invalid cron schedule: invalid; invalid_fresh_duration at flow.sequence[0].freshDuration: freshDuration requires fresh=true; invalid_fresh_duration at flow.sequence[0].freshDuration: freshDuration must be a positive fixed ISO 8601 duration using D, H, M, or S; invalid_flow_next at flow.sequence[0].next: flow target must be continue, succeed, fail, or a step id in the same phase; invalid_fresh_duration at flow.sequence[0].freshDuration: freshDuration is only supported for scheduled flow jobs'
    )
  }
  expect(formatJobFlowValidationErrors([])).toBe('')
})
