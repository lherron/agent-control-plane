import type { WorkflowTask } from 'acp-core'

export function renderWorkflowTask(task: WorkflowTask): string {
  return [
    `Task ${task.taskId}`,
    `Project: ${task.projectId}`,
    `Workflow: ${task.workflow.id}@${task.workflow.version}`,
    `Hash: ${task.workflow.hash}`,
    `Status: ${task.state.status}`,
    `Phase: ${task.state.phase ?? 'none'}`,
    `Outcome: ${task.state.outcome ?? 'none'}`,
    `Version: ${task.version}`,
    `Goal: ${task.goal}`,
    `Risk: ${task.risk ?? 'n/a'}`,
    'Roles:',
    ...Object.entries(task.roleBindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([role, actor]) => `  ${role}: ${actor === null ? 'unbound' : `${actor.kind}:${actor.id}`}`
      ),
  ].join('\n')
}
