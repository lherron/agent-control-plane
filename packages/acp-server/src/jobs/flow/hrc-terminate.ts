import type { Actor } from 'acp-core'

// The job runner terminates HRC runtimes it owns (stale fresh-step runtimes,
// timed-out agent steps) with one audit identity.
export function jobRunnerTerminateOptions(reason: string, actor: Actor) {
  return {
    dropContinuation: false,
    reason,
    source: 'acp-scheduled-job-runner',
    actor: actorToAuditString(actor),
  }
}

function actorToAuditString(actor: Actor): string {
  return actor.displayName !== undefined
    ? `${actor.kind}:${actor.id} (${actor.displayName})`
    : `${actor.kind}:${actor.id}`
}
