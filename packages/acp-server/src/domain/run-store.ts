import { randomUUID } from 'node:crypto'

import type { Run } from 'acp-core'
import type { SessionRef } from 'agent-scope'

export interface RunStore {
  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): Run
  getRun(runId: string): Run | undefined
  listRuns(): readonly Run[]
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>()

  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): Run {
    const run: Run = {
      runId: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    this.runs.set(run.runId, run)
    return structuredClone(run)
  }

  getRun(runId: string): Run | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : structuredClone(run)
  }

  listRuns(): readonly Run[] {
    return [...this.runs.values()].map((run) => structuredClone(run))
  }
}
