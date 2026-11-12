import {
  type ObligationRecord,
  type WorkflowDefinition,
  createInMemoryWorkflowKernel,
} from '../../packages/acp-core/src/workflow/index.js'

export type Kernel = ReturnType<typeof createInMemoryWorkflowKernel>
const NOW = '2026-05-09T12:00:00.000Z'

export function publishKernel(workflow: WorkflowDefinition): Kernel {
  const kernel = createInMemoryWorkflowKernel({ now: NOW })
  kernel.publishWorkflowDefinition(workflow)
  return kernel
}

export function findObligationByKind(
  kernel: Kernel,
  taskId: string,
  kind: string
): ObligationRecord {
  const list = kernel.listObligations(taskId)
  const found = [...list].reverse().find((o) => o.kind === kind && o.status === 'open')
  if (!found) {
    throw new Error(`No open obligation of kind=${kind} for task ${taskId}`)
  }
  return found
}

type RejectionTaskInput = Omit<
  Parameters<Kernel['createTask']>[0],
  'workflow' | 'projectId' | 'goal'
>

export function createRejectionTask(
  kernel: Kernel,
  workflow: WorkflowDefinition,
  input: RejectionTaskInput
) {
  return kernel.createTask({
    projectId: 'demo',
    workflow: { id: workflow.id, version: workflow.version },
    goal: 'g',
    ...input,
  })
}
