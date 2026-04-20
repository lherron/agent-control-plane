import type { Task } from 'acp-core'

export function createBareWrkqBugTask(projectId: string, taskId: string): Task {
  return {
    taskId,
    projectId,
    kind: 'bug',
    lifecycleState: 'open',
    phase: '',
    roleMap: {},
    version: 0,
  }
}
