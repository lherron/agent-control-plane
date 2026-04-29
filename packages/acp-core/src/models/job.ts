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

export type JobFlowStep = AgentFlowStep | ExecFlowStep

export type FlowNext = string | 'continue' | 'succeed' | 'fail'

export type BaseFlowStep = {
  id: string
  kind?: 'agent' | 'exec' | undefined
  timeout?: string | undefined
  fresh?: boolean | undefined
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
  }
  branches?:
    | {
        exitCode?: Readonly<Record<string, FlowNext>> | undefined
        default?: FlowNext | undefined
      }
    | undefined
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
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
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
