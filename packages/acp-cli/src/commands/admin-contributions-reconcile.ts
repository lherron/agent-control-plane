import { CliUsageError } from '../cli-runtime.js'
import { hasFlag, parseArgs, readStringFlag, requireNoPositionals } from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type ReconcileResponse = {
  results: Array<{
    inputApplicationId: string
    inputAttemptId: string
    previousStatus: string
    status: 'accepted' | 'failed' | 'pending'
    hrcStatus?: string | undefined
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }>
  summary: {
    accepted: number
    failed: number
    pending: number
  }
}

export async function runAdminContributionsReconcileCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--all-pending', '--json'],
    stringFlags: ['--input-application-id', '--server', '--actor'],
  })
  requireNoPositionals(parsed)

  const inputApplicationId = readStringFlag(parsed, '--input-application-id')?.trim()
  const allPending = hasFlag(parsed, '--all-pending')

  if (inputApplicationId !== undefined && inputApplicationId.length > 0 && allPending) {
    throw new CliUsageError('provide either --input-application-id or --all-pending, not both')
  }
  if ((inputApplicationId === undefined || inputApplicationId.length === 0) && !allPending) {
    throw new CliUsageError('--input-application-id or --all-pending is required')
  }

  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<ReconcileResponse>({
    method: 'POST',
    path: '/v1/admin/contributions/reconcile',
    body:
      allPending === true
        ? { allPending: true }
        : { inputApplicationId: inputApplicationId as string },
  })

  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderReconcileText(response))
}

function renderReconcileText(response: ReconcileResponse): string {
  const lines = response.results.map((result) => {
    const hrcStatus = result.hrcStatus === undefined ? '' : ` hrc=${result.hrcStatus}`
    const error = result.errorCode === undefined ? '' : ` error=${result.errorCode}`
    return `${result.inputApplicationId} ${result.previousStatus}->${result.status}${hrcStatus}${error}`
  })
  lines.push(
    `accepted ${response.summary.accepted} / failed ${response.summary.failed} / pending ${response.summary.pending}`
  )
  return lines.join('\n')
}
