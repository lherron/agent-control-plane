import type { SessionRef } from 'agent-scope'

import type { DeliveryTarget } from '../interface/delivery-target.js'

export type Job = {
  jobId: string
  sessionRef: SessionRef
  enabled: boolean
  createdAt: string
  updatedAt: string
  deliveryTarget?: DeliveryTarget | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}

export type JobRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type JobRun = {
  jobRunId: string
  jobId: string
  status: JobRunStatus
  scheduledFor?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}

export type JobFlow = {
  sequence: JobFlowStep[]
  onFailure?: JobFlowStep[] | undefined
}

export type JobFlowStep =
  | AgentFlowStep
  | ExecFlowStep
  | ProbeFlowStep
  | WrkqTaskFlowStep
  | PulpitMessageFlowStep
  | AgentDispatchFlowStep

export type FlowNext = string | 'continue' | 'succeed' | 'fail'

/**
 * A reference to a top-level output field of a prior step in the same phase.
 * Authority-bearing fields in native side-effect steps (wrkq-task,
 * pulpit-message, agent-dispatch) may use this instead of a literal string,
 * letting a prior step's result compose structural values without exposing raw
 * event payload to authority surfaces.
 */
export type StepOutputRef = {
  /** Id of the prior step whose result to reference. Must appear BEFORE this step in the same phase. */
  readonly $step: string
  /**
   * Top-level field name from the referenced step's result object.
   * Must be a bare identifier — no dots, brackets, or other path notation.
   */
  readonly field: string
}

export type BaseFlowStep = {
  id: string
  kind?: 'agent' | 'exec' | 'probe' | 'wrkq-task' | 'pulpit-message' | 'agent-dispatch' | undefined
  timeout?: string | undefined
  fresh?: boolean | undefined
  freshDuration?: string | undefined
  next?: FlowNext | undefined
}

export type AgentFlowStep = BaseFlowStep & {
  kind?: 'agent' | undefined
  input?: string | undefined
  inputFile?: string | undefined
  expect?: StepExpectation | undefined
}

export type ExecFlowStep = BaseFlowStep & {
  kind: 'exec'
  input?: undefined
  inputFile?: undefined
  expect?: undefined
  exec: {
    argv: string[]
    cwd?: string | undefined
    env?: Readonly<Record<string, string>> | undefined
    timeout?: string | undefined
    maxOutputBytes?: number | undefined
    successExitCodes?: readonly number[] | undefined
  }
  branches?:
    | {
        exitCode?: Readonly<Record<string, FlowNext>> | undefined
        default?: FlowNext | undefined
      }
    | undefined
}

export type ProbeOutcome = 'idle' | 'work'

export type ProbeFlowStep = BaseFlowStep & {
  kind: 'probe'
  input?: undefined
  inputFile?: undefined
  expect?: undefined
  probe: {
    name: string
  }
  branches?:
    | {
        outcome?: Readonly<Record<ProbeOutcome, FlowNext>> | undefined
      }
    | undefined
}

export type WrkqTaskFlowStep = BaseFlowStep & {
  kind: 'wrkq-task'
  /** Task title — content field, may contain {{…}} template expressions. */
  title: string | StepOutputRef
  /**
   * Target container path (e.g. "agent-control-plane/inbox") — authority field.
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  container: string | StepOutputRef
  description?: string | StepOutputRef | undefined
  taskKind?: string | undefined
  labels?: string[] | undefined
}

export type PulpitMessageFlowStep = BaseFlowStep & {
  kind: 'pulpit-message'
  /** Message body — content field, may contain {{…}} template expressions. */
  content: string | StepOutputRef
  /**
   * Pulpit binding selector — authority field.
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  binding: string | StepOutputRef
}

export type AgentDispatchFlowStep = BaseFlowStep & {
  kind: 'agent-dispatch'
  /**
   * Target session scope ref — authority field.
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  scopeRef: string | StepOutputRef
  /**
   * Target agent id — authority field for structural scope construction.
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  agentId?: string | StepOutputRef | undefined
  /**
   * Target project id — authority field for structural scope construction.
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  projectId?: string | StepOutputRef | undefined
  /**
   * Target lane ref — authority field (optional, defaults to main at runtime).
   * Must be a literal string or a step-output ref; template expressions are not
   * permitted here.
   */
  laneRef?: string | StepOutputRef | undefined
  /** Dispatch input — content fields, may contain {{…}} template expressions. */
  input?: Readonly<Record<string, string | StepOutputRef>> | undefined
}

export type StepExpectation = {
  outcome?: 'succeeded' | 'failed' | 'cancelled' | undefined
  resultBlock?: string | undefined
  require?: string[] | undefined
  equals?: Readonly<Record<string, string | number | boolean | null>> | undefined
}

export type JobStepRunPhase = 'sequence' | 'onFailure'

export type JobStepRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type JobStepRun = {
  jobRunId: string
  stepId: string
  phase: JobStepRunPhase
  status: JobStepRunStatus
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  branchTaken?: BranchTaken | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
}

export type BranchTaken = {
  kind: 'exitCode' | 'outcome' | 'default'
  key: string
  target: FlowNext
}

export type ExecStepResult = {
  kind: 'exec'
  argv: string[]
  cwd: string
  exitCode: number | null
  signal?: string | undefined
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
  startedAt: string
  completedAt: string
}

export type ProbeStepResult = {
  kind: 'probe'
  name: string
  outcome: ProbeOutcome
}
