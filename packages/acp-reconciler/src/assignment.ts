import type { Decision } from './evaluate.js'
import type { RequestRecord } from './model.js'

/** The initial assignment the worker's session receives through HRC. */
export function assignmentBody(
  request: RequestRecord,
  start: Extract<Decision, { kind: 'start' }>
): string {
  const assignment = `${request.id}@${start.rev}`
  const timelineTask = request.ownerId ?? request.id
  return [
    `Delegated assignment ${assignment} for agent:${start.agentId} (seat ${start.seat}).`,
    '',
    'Load the `delegated-work` skill and follow it for this assignment:',
    `- Read the request: \`wrkq cat ${request.id}\`${
      request.ownerId !== undefined
        ? `, and its owner's shared context: \`wrkq cat ${request.ownerId}\``
        : ''
    }.`,
    `- Read the activity timeline: \`wrkp log --task ${timelineTask}\`.`,
    `- Claim ${request.id} before touching any output.`,
    `- After claiming, re-read the request and proceed only if its assignee is agent:${start.agentId} and meta.acp.request.rev is ${start.rev}; otherwise reject per the skill.`,
    `- If ${request.id} is already completed or claimed, this initial assignment is a no-op.`,
    '',
    'Record your result on the request, complete it, release your claim, then send the requester one --fyi notice. This assignment carries no reply obligation; do not message the reconciler.',
  ].join('\n')
}

export function stallNoticeBody(
  request: RequestRecord,
  stall: Extract<Decision, { kind: 'stall' }>
): string {
  const evidence = Object.entries(stall.evidence ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return [
    `Delegation stall on ${request.id}: ${stall.stall.kind} — ${stall.reason}.`,
    evidence === '' ? undefined : `Evidence: ${evidence}`,
    'Nothing was released, retried or failed. Recovery is deliberate: inspect the seat, then bump meta.acp.request.rev and reopen, or reassign.',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
