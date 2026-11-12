#!/usr/bin/env bun
/**
 * Independent end-to-end validator for scenarios/flow-presets/*.
 *
 * Drives each scenario through the in-memory ACP workflow kernel:
 *  - publishWorkflowDefinition(workflow.json)
 *  - createTask(...) per scenario.json step 01
 *  - apply each subsequent transition / control action
 *  - assert expected state, effects, obligations after each step
 *  - run scenario.json negativeChecks against fresh kernel/task fixtures
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  EffectIntent,
  ObligationRecord,
  WorkflowDefinition,
} from '../packages/acp-core/src/workflow/index.js'
import type { NegResult, RunReport, Scenario } from './scenario-validation/contract.js'
import { runHappyPath } from './scenario-validation/happy-path.js'
import { runHotfixChecks } from './scenario-validation/hotfix-rejections.js'
import { runProcurementChecks } from './scenario-validation/procurement-rejections.js'
import { runSupportChecks } from './scenario-validation/support-rejections.js'

const rejectionChecks: Record<string, (workflow: WorkflowDefinition) => NegResult[]> = {
  'hotfix-implementer-tester': runHotfixChecks,
  'support-escalation-customer-response': runSupportChecks,
  'procurement-legal-approval': runProcurementChecks,
}

const SCENARIOS = [
  'scenarios/flow-presets/hotfix-implementer-tester',
  'scenarios/flow-presets/support-escalation-customer-response',
  'scenarios/flow-presets/procurement-legal-approval',
]

const REPO_ROOT = resolve(import.meta.dir, '..')

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function runScenario(scenarioFolder: string): RunReport {
  const folder = join(REPO_ROOT, scenarioFolder)
  const scenario: Scenario = loadJson<Scenario>(join(folder, 'scenario.json'))
  const workflow: WorkflowDefinition = loadJson<WorkflowDefinition>(join(folder, 'workflow.json'))

  const happy = runHappyPath(scenario, workflow)
  const neg = rejectionChecks[scenario.scenarioId]?.(workflow) ?? []

  const happyStatus = happy.failures.length === 0 ? 'pass' : 'fail'
  const negFails = neg.filter((n) => n.status === 'fail').length
  const overall = happyStatus === 'pass' && negFails === 0 ? 'pass' : 'fail'

  const effectKindsObserved = happy.task?.taskId
    ? happy.kernel
        .listEffectIntents(happy.task.taskId)
        .map((e: EffectIntent) => e.kind)
        .sort()
    : []
  const obligationFinalStates = happy.task?.taskId
    ? happy.kernel
        .listObligations(happy.task.taskId)
        .map((o: ObligationRecord) => `${o.kind}=${o.status}`)
    : []

  return {
    scenarioId: scenario.scenarioId,
    status: overall,
    happyPath: { status: happyStatus, failures: happy.failures, lastTask: happy.task },
    negative: neg.map((n) => ({
      name: n.name,
      expected: n.expected,
      got: n.got,
      status: n.status,
    })),
    effectKindsObserved,
    obligationFinalStates,
  }
}

const reports: RunReport[] = []
for (const folder of SCENARIOS) {
  reports.push(runScenario(folder))
}

let allPass = true
for (const r of reports) {
  console.log(`\n=== ${r.scenarioId}: ${r.status.toUpperCase()} ===`)
  console.log(
    `  happy path: ${r.happyPath.status}${
      r.happyPath.failures.length
        ? `\n    failures:\n${r.happyPath.failures.map((f) => `      - [${f.step}] ${f.message}`).join('\n')}`
        : ''
    }`
  )
  if (r.happyPath.lastTask) {
    console.log(
      `    terminal state: status=${r.happyPath.lastTask.state.status} phase=${String(r.happyPath.lastTask.state.phase)} outcome=${String(r.happyPath.lastTask.state.outcome ?? '-')}`
    )
  }
  if (r.effectKindsObserved?.length) {
    console.log(`    effect intents observed: ${r.effectKindsObserved.join(', ')}`)
  }
  if (r.obligationFinalStates?.length) {
    console.log(`    obligation final states: ${r.obligationFinalStates.join(', ')}`)
  }
  console.log('  negative checks:')
  for (const n of r.negative) {
    console.log(
      `    - ${n.status === 'pass' ? 'PASS' : 'FAIL'}  ${n.name}: expected=${n.expected} got=${n.got}`
    )
  }
  if (r.status !== 'pass') allPass = false
}

console.log(`\n>>> OVERALL: ${allPass ? 'SCENARIO-VALIDATION PASS' : 'SCENARIO-VALIDATION FAIL'}`)
process.exit(allPass ? 0 : 1)
