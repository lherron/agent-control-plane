import type { EvidenceItem } from 'acp-core'

export function renderAttachedEvidence(input: {
  taskId: string
  evidenceId?: string | undefined
  evidence: EvidenceItem
}): string {
  const label = input.evidenceId !== undefined ? input.evidenceId : 'evidence'
  return `Attached ${label} to ${input.taskId} (kind=${input.evidence.kind} ref=${input.evidence.ref})`
}

export function renderEvidenceList(evidence: readonly EvidenceItem[]): string {
  if (evidence.length === 0) {
    return 'No evidence items.'
  }

  return evidence.map((item) => `- ${item.kind}: ${item.ref}`).join('\n')
}
