import type { Task, WorkflowTask } from 'acp-core'

import type { TaskContext } from '../http-client.js'

function renderRoleMap(task: Task): string[] {
  const roles = Object.entries(task.roleMap).sort(([left], [right]) => left.localeCompare(right))
  return roles.length === 0
    ? ['Roles: none']
    : ['Roles:', ...roles.map(([role, agentId]) => `  ${role}: ${agentId}`)]
}

export function renderTask(input: { task: Task; context?: TaskContext | undefined }): string {
  const { task, context } = input
  const lines = [
    `Task ${task.taskId}`,
    `Project: ${task.projectId}`,
    `Kind: ${task.kind}`,
    `Lifecycle: ${task.lifecycleState}`,
    `Phase: ${task.phase}`,
    `Version: ${task.version}`,
    `Preset: ${task.workflowPreset ?? 'none'}${task.presetVersion !== undefined ? ` v${task.presetVersion}` : ''}`,
    `Risk: ${task.riskClass ?? 'n/a'}`,
    ...renderRoleMap(task),
  ]

  if (task.meta !== undefined) {
    lines.push(`Meta: ${JSON.stringify(task.meta)}`)
  }

  if (context !== undefined) {
    lines.push('')
    lines.push('Current task context:')
    lines.push(`  phase: ${context.phase}`)
    lines.push(`  requiredEvidenceKinds: ${context.requiredEvidenceKinds.join(', ') || 'none'}`)
    lines.push('  hintsText:')
    for (const line of context.hintsText.split('\n')) {
      lines.push(`    ${line}`)
    }
  }

  return lines.join('\n')
}

export function renderCreatedTask(task: Task): string {
  const lines = [
    `Created ${task.taskId} (preset=${task.workflowPreset ?? 'none'} v=${task.presetVersion ?? 0} phase=${task.phase} risk=${task.riskClass ?? 'n/a'})`,
    'Roles:',
    ...Object.entries(task.roleMap)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, agentId]) => `  ${role}: ${agentId}`),
  ]

  return lines.join('\n')
}

export function renderCreatedWorkflowTask(task: WorkflowTask): string {
  const lines = [
    `Created ${task.taskId} (workflow=${task.workflow.id}@${task.workflow.version} status=${task.state.status} phase=${task.state.phase ?? 'none'} risk=${task.risk ?? 'n/a'})`,
    'Roles:',
    ...Object.entries(task.roleBindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([role, actor]) => `  ${role}: ${actor === null ? 'unbound' : `${actor.kind}:${actor.id}`}`
      ),
  ]

  return lines.join('\n')
}

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

export function renderPromotedTask(task: Task): string {
  const lines = [
    `Promoted ${task.taskId} to ${task.workflowPreset ?? 'none'} v${task.presetVersion ?? 0} (phase=${task.phase}, risk=${task.riskClass ?? 'n/a'})`,
    'Roles:',
    ...Object.entries(task.roleMap)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, agentId]) => `  ${role}: ${agentId}`),
  ]

  return lines.join('\n')
}
