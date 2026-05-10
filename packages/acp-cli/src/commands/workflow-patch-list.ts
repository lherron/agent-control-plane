import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type PatchSummary = {
  proposalId: string
  baseWorkflow: { id: string; version: number; hash: string }
  patchKind: string
  status: string
  createdBy: { kind: string; id: string }
  createdAt: string
  sourceAnomalyIds: string[]
  rationaleSummary: string
}

type ListResponse = {
  proposals: PatchSummary[]
}

function renderProposalSummary(p: PatchSummary): string {
  const lines: string[] = []
  lines.push(`Proposal:  ${p.proposalId}`)
  lines.push(`Workflow:  ${p.baseWorkflow.id}@${p.baseWorkflow.version}`)
  lines.push(`Kind:      ${p.patchKind}`)
  lines.push(`Status:    ${p.status}`)
  lines.push(`Created:   ${p.createdAt} by ${p.createdBy.kind}:${p.createdBy.id}`)
  lines.push(`Rationale: ${p.rationaleSummary}`)
  if (p.sourceAnomalyIds.length > 0) {
    lines.push(`Anomalies: ${p.sourceAnomalyIds.join(', ')}`)
  }
  return lines.join('\n')
}

export async function runWorkflowPatchListCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--task', '--status', '--limit', '--server', '--actor'],
  })
  requireNoPositionals(parsed)

  const taskId = requireStringFlag(parsed, '--task')
  const requester = createRawRequesterFromParsed(parsed, deps)

  const params = new URLSearchParams()
  const statusFilter = readStringFlag(parsed, '--status')
  if (statusFilter !== undefined) {
    params.set('status', statusFilter)
  }
  const limitRaw = readStringFlag(parsed, '--limit')
  if (limitRaw !== undefined) {
    params.set('limit', String(parseIntegerValue('--limit', limitRaw, { min: 1 })))
  }

  const qs = params.toString()
  const path = `/v1/tasks/${encodeURIComponent(taskId)}/workflow-patch-proposals${qs ? `?${qs}` : ''}`

  const response = await requester.requestJson<ListResponse>({
    method: 'GET',
    path,
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  if (response.proposals.length === 0) {
    return asText('No patch proposals found.')
  }

  const text = response.proposals.map(renderProposalSummary).join('\n\n')
  return asText(text)
}
