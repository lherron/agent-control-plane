import { hasFlag, parseArgs } from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type PatchProposal = {
  proposalId: string
  taskId: string
  baseWorkflow: { id: string; version: number; hash: string }
  patchKind: string
  status: string
  createdBy: { kind: string; id: string }
  createdAt: string
  sourceAnomalyIds: string[]
  rationaleSummary: string
  patch: unknown
  replayExpectations: unknown
}

type ShowResponse = {
  proposal: PatchProposal
}

function renderProposalDetail(p: PatchProposal): string {
  const lines: string[] = []
  lines.push(`Proposal:  ${p.proposalId}`)
  lines.push(`Task:      ${p.taskId}`)
  lines.push(`Workflow:  ${p.baseWorkflow.id}@${p.baseWorkflow.version}`)
  lines.push(`Kind:      ${p.patchKind}`)
  lines.push(`Status:    ${p.status}`)
  lines.push(`Created:   ${p.createdAt} by ${p.createdBy.kind}:${p.createdBy.id}`)
  lines.push(`Rationale: ${p.rationaleSummary}`)
  if (p.sourceAnomalyIds.length > 0) {
    lines.push(`Anomalies: ${p.sourceAnomalyIds.join(', ')}`)
  }
  lines.push('Patch:     [use --json or --raw for full payload]')
  return lines.join('\n')
}

export async function runWorkflowPatchShowCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--raw'],
    stringFlags: ['--server', '--actor'],
  })

  if (parsed.positionals.length !== 1) {
    const { CliUsageError } = await import('../cli-runtime.js')
    throw new CliUsageError('usage: acp workflow patch show <proposalId>')
  }

  const proposalId = parsed.positionals[0] as string
  const requester = createRawRequesterFromParsed(parsed, deps)

  const path = `/v1/workflow-patch-proposals/${encodeURIComponent(proposalId)}`
  const response = await requester.requestJson<ShowResponse>({
    method: 'GET',
    path,
  })

  if (hasFlag(parsed, '--json') || hasFlag(parsed, '--raw')) {
    return asJson(response)
  }

  return asText(renderProposalDetail(response.proposal))
}
