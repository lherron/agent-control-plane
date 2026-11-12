import type {
  ActorRef,
  EvidenceInput,
  WorkflowRejectionCode,
  WorkflowTask,
} from '../../packages/acp-core/src/workflow/index.js'

interface ScenarioActorBinding {
  binding: string
  actor: ActorRef
}

export interface ScenarioStep {
  stepId: string
  summary: string
  actorBinding: string
  expectedStateAfter?: { status?: string; phase?: string | null; outcome?: string }
  evidence?: EvidenceInput[]
  transitionId?: string
  kernel?: { op: string; args: Record<string, unknown> }
  controlAction?: {
    type: string
    obligationKind?: string
    evidence?: EvidenceInput[]
    supervisorActor?: string
  }
  expectedEffects?: Array<{ kind: string; payload?: Record<string, unknown> }>
}

interface NegativeCheck {
  name: string
  summary: string
  expectedRejection: WorkflowRejectionCode
  note?: string
}

export interface Scenario {
  scenarioId: string
  title: string
  workflow: { id: string; version: number; definitionFile: string }
  task: {
    taskId: string
    projectId: string
    goal: string
    risk?: string
    initialFacts?: Record<string, unknown>
  }
  actors: ScenarioActorBinding[]
  supervisor?: {
    actor: ActorRef
    autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
    capabilities: Record<string, boolean>
  }
  steps: ScenarioStep[]
  negativeChecks?: NegativeCheck[]
}

export interface AssertionFailure {
  step: string
  message: string
}

export interface RunReport {
  scenarioId: string
  status: 'pass' | 'fail'
  happyPath: {
    status: 'pass' | 'fail'
    failures: AssertionFailure[]
    lastTask?: WorkflowTask | undefined
  }
  negative: Array<{ name: string; expected: string; got: string; status: 'pass' | 'fail' }>
  effectKindsObserved?: string[]
  obligationFinalStates?: string[]
}

export interface NegResult {
  name: string
  expected: WorkflowRejectionCode
  got: string
  status: 'pass' | 'fail'
}
