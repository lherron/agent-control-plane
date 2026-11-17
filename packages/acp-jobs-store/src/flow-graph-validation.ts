import type { FlowNext } from 'acp-core'

import {
  type FlowPhase,
  type FlowPhaseSteps,
  type JobFlowValidationError,
  addError,
  hasPresentString,
  isRecord,
} from './flow-validation-context.js'

const terminalFlowNext = new Set<FlowNext>(['continue', 'succeed', 'fail'])
export function validateBranchShape(
  step: Record<string, unknown>,
  path: string,
  stepKind: string,
  errors: JobFlowValidationError[]
): void {
  if (!('branches' in step)) {
    if (stepKind === 'probe') {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.outcome`,
        'probe step must include branches.outcome'
      )
    }
    return
  }

  const branches = step['branches']
  if (!isRecord(branches)) {
    addError(errors, 'invalid_flow_next', `${path}.branches`, 'branches must be an object')
    return
  }

  if ('exitCode' in branches) {
    if (stepKind !== 'exec') {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.exitCode`,
        'probe steps must branch on outcome, not exitCode'
      )
      return
    }
    const exitCode = branches['exitCode']
    if (!isRecord(exitCode)) {
      addError(
        errors,
        'invalid_branch_exit_code',
        `${path}.branches.exitCode`,
        'branches.exitCode must be an object'
      )
    } else {
      for (const [exitCodeKey, target] of Object.entries(exitCode)) {
        if (!isValidExitCodeKey(exitCodeKey)) {
          addError(
            errors,
            'invalid_branch_exit_code',
            `${path}.branches.exitCode.${exitCodeKey}`,
            'branch exit codes must be integer strings from 0 to 255'
          )
        }
        if (typeof target !== 'string') {
          addError(
            errors,
            'invalid_flow_next',
            `${path}.branches.exitCode.${exitCodeKey}`,
            'branch target must be a terminal token or step id'
          )
        }
      }
    }
  }

  if ('outcome' in branches) {
    if (stepKind !== 'probe') {
      addError(
        errors,
        'invalid_flow_next',
        `${path}.branches.outcome`,
        'outcome branches are only supported on probe steps'
      )
      return
    }
    const outcome = branches['outcome']
    if (!isRecord(outcome)) {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.outcome`,
        'branches.outcome must be an object'
      )
    } else {
      for (const key of Object.keys(outcome)) {
        if (key !== 'idle' && key !== 'work') {
          addError(
            errors,
            'invalid_probe_step',
            `${path}.branches.outcome.${key}`,
            'probe outcome branches must be idle or work'
          )
        }
      }
      for (const key of ['idle', 'work'] as const) {
        const target = outcome[key]
        if (typeof target !== 'string') {
          addError(
            errors,
            'invalid_flow_next',
            `${path}.branches.outcome.${key}`,
            'branch target must be a terminal token or step id'
          )
        }
      }
    }
  }

  if (stepKind === 'probe' && !('outcome' in branches)) {
    addError(
      errors,
      'invalid_probe_step',
      `${path}.branches.outcome`,
      'probe step must include branches.outcome'
    )
  }

  if ('default' in branches && typeof branches['default'] !== 'string') {
    addError(
      errors,
      'invalid_flow_next',
      `${path}.branches.default`,
      'branch default must be a terminal token or step id'
    )
  }
}

function isValidExitCodeKey(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false
  }
  const exitCode = Number(value)
  return isValidExitCodeNumber(exitCode)
}

export function isValidExitCodeNumber(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return false
  }
  const exitCode = value
  return exitCode >= 0 && exitCode <= 255
}

function collectPhaseStepIds(steps: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const step of steps) {
    if (isRecord(step) && hasPresentString(step, 'id')) {
      ids.add(step['id'] as string)
    }
  }
  return ids
}

function validateFlowNextTarget(
  target: unknown,
  path: string,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): void {
  if (typeof target !== 'string') {
    return
  }

  if (!terminalFlowNext.has(target as FlowNext) && !phaseStepIds.has(target)) {
    addError(
      errors,
      'invalid_flow_next',
      path,
      'flow target must be continue, succeed, fail, or a step id in the same phase'
    )
  }
}

function validateBranchTargets(
  steps: unknown[],
  phase: FlowPhase,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): void {
  steps.forEach((step, index) => {
    if (!isRecord(step)) {
      return
    }

    const path = `flow.${phase}[${index}]`
    if ('next' in step) {
      validateFlowNextTarget(step['next'], `${path}.next`, phaseStepIds, errors)
    }

    if ((step['kind'] !== 'exec' && step['kind'] !== 'probe') || !isRecord(step['branches'])) {
      return
    }

    const branches = step['branches']
    if (isRecord(branches['exitCode'])) {
      for (const [exitCode, target] of Object.entries(branches['exitCode'])) {
        validateFlowNextTarget(
          target,
          `${path}.branches.exitCode.${exitCode}`,
          phaseStepIds,
          errors
        )
      }
    }

    if (isRecord(branches['outcome'])) {
      for (const [outcome, target] of Object.entries(branches['outcome'])) {
        validateFlowNextTarget(target, `${path}.branches.outcome.${outcome}`, phaseStepIds, errors)
      }
    }

    if ('default' in branches) {
      validateFlowNextTarget(branches['default'], `${path}.branches.default`, phaseStepIds, errors)
    }
  })
}

function addEdgeForFlowNext(
  edges: Map<string, Set<string>>,
  from: string,
  target: unknown,
  phaseStepIds: Set<string>
): void {
  if (
    typeof target !== 'string' ||
    terminalFlowNext.has(target as FlowNext) ||
    !phaseStepIds.has(target)
  ) {
    return
  }

  edges.get(from)?.add(target)
}

function validatePhaseAcyclic(
  steps: unknown[],
  phase: FlowPhase,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): void {
  const orderedIds = steps
    .filter(
      (step): step is Record<string, unknown> => isRecord(step) && hasPresentString(step, 'id')
    )
    .map((step) => step['id'] as string)
  const edges = new Map(orderedIds.map((id) => [id, new Set<string>()]))

  for (const [index, id] of orderedIds.entries()) {
    const nextId = orderedIds[index + 1]
    if (nextId !== undefined) {
      edges.get(id)?.add(nextId)
    }
  }

  for (const step of steps) {
    if (!isRecord(step) || !hasPresentString(step, 'id')) {
      continue
    }

    const id = step['id'] as string
    addEdgeForFlowNext(edges, id, step['next'], phaseStepIds)

    if ((step['kind'] !== 'exec' && step['kind'] !== 'probe') || !isRecord(step['branches'])) {
      continue
    }

    const branches = step['branches']
    if (isRecord(branches['exitCode'])) {
      for (const target of Object.values(branches['exitCode'])) {
        addEdgeForFlowNext(edges, id, target, phaseStepIds)
      }
    }
    if (isRecord(branches['outcome'])) {
      for (const target of Object.values(branches['outcome'])) {
        addEdgeForFlowNext(edges, id, target, phaseStepIds)
      }
    }
    addEdgeForFlowNext(edges, id, branches['default'], phaseStepIds)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(id: string): boolean {
    if (visiting.has(id)) {
      return true
    }
    if (visited.has(id)) {
      return false
    }

    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) {
        return true
      }
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const id of orderedIds) {
    if (visit(id)) {
      addError(errors, 'flow_cycle', `flow.${phase}`, `flow.${phase} contains a cycle`)
      return
    }
  }
}

export function validatePhaseFlowGraph(
  phases: FlowPhaseSteps,
  errors: JobFlowValidationError[]
): void {
  for (const phase of ['sequence', 'onFailure'] as const) {
    const steps = phases[phase]
    if (steps === undefined) {
      continue
    }

    const phaseStepIds = collectPhaseStepIds(steps)
    validateBranchTargets(steps, phase, phaseStepIds, errors)
  }

  if (errors.length > 0) {
    return
  }

  for (const phase of ['sequence', 'onFailure'] as const) {
    const steps = phases[phase]
    if (steps === undefined) {
      continue
    }

    validatePhaseAcyclic(steps, phase, collectPhaseStepIds(steps), errors)
  }
}
