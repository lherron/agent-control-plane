import { json, notFound } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import { withDurableWorkflowKernel } from '../workflow-runtime.js'

function requireTaskId(params: Record<string, string | undefined>): string {
  const taskId = params['taskId']
  if (taskId === undefined || taskId.length === 0) {
    throw new Error('taskId route parameter is required')
  }
  return taskId
}

function requireProposalId(params: Record<string, string | undefined>): string {
  const proposalId = params['proposalId']
  if (proposalId === undefined || proposalId.length === 0) {
    throw new Error('proposalId route parameter is required')
  }
  return proposalId
}

export const handleListWorkflowPatchProposals: RouteHandler = async ({ url, params, deps }) => {
  const taskId = requireTaskId(params)
  const statusFilter = url.searchParams.get('status') ?? undefined
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam !== null ? Math.max(1, Number.parseInt(limitParam, 10) || 50) : 50

  const proposals = withDurableWorkflowKernel(deps, (kernel) => {
    let results = kernel.listWorkflowPatchProposals(taskId)
    if (statusFilter !== undefined) {
      results = results.filter((p) => p.status === statusFilter)
    }
    return results.slice(0, limit)
  })

  const summaries = proposals.map((p) => ({
    proposalId: p.proposalId,
    baseWorkflow: p.baseWorkflow,
    patchKind: p.patchKind,
    status: p.status,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    sourceAnomalyIds: p.sourceAnomalyIds,
    rationaleSummary: p.rationaleSummary,
  }))

  return json({ proposals: summaries })
}

export const handleShowWorkflowPatchProposal: RouteHandler = async ({ params, deps }) => {
  const proposalId = requireProposalId(params)

  const proposal = withDurableWorkflowKernel(deps, (kernel) => {
    const snapshot = kernel.exportSnapshot()
    for (const p of snapshot.patchProposals) {
      if (p.proposalId === proposalId) {
        return p
      }
    }
    return undefined
  })

  if (proposal === undefined) {
    notFound(`workflow patch proposal not found: ${proposalId}`, { proposalId })
  }

  return json({
    proposal: {
      proposalId: proposal.proposalId,
      taskId: proposal.taskId,
      baseWorkflow: proposal.baseWorkflow,
      patchKind: proposal.patchKind,
      status: proposal.status,
      createdBy: proposal.createdBy,
      createdAt: proposal.createdAt,
      sourceAnomalyIds: proposal.sourceAnomalyIds,
      rationaleSummary: proposal.rationaleSummary,
      patch: proposal.patch,
      replayExpectations: {},
    },
  })
}
