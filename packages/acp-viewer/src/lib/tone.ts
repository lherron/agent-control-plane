// Shared status -> Pill tone mappers. Two distinct mappings are intentional and
// must NOT be merged: heartbeat statuses (alive/stale/dead/down) and run-status
// statuses (succeeded/failed/skipped) key on different strings.

type Tone = 'success' | 'destructive' | 'warn' | 'muted'

export function heartbeatTone(status: string): Tone {
  if (status === 'alive') return 'success'
  if (status === 'stale') return 'warn'
  if (status === 'dead' || status === 'down') return 'destructive'
  return 'muted'
}

export function runStatusTone(status: string): Tone {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'skipped') return 'warn'
  return 'muted'
}
