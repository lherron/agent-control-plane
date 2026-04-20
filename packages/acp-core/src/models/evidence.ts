export interface EvidenceProducer {
  agentId: string
  role?: string | undefined
}

export interface EvidenceBuild {
  id?: string | undefined
  version?: string | undefined
  env?: string | undefined
}

export interface EvidenceDetails {
  waiverKind?: string | undefined
  scope?: string | undefined
  expiresAt?: string | undefined
  reason?: string | undefined
  [key: string]: unknown
}

export interface EvidenceItem {
  kind: string
  ref: string
  contentHash?: string | undefined
  producedBy?: EvidenceProducer | undefined
  timestamp?: string | undefined
  build?: EvidenceBuild | undefined
  details?: EvidenceDetails | undefined
}

export function listEvidenceKinds(evidence: readonly EvidenceItem[]): string[] {
  return evidence.map((item) => item.kind)
}

export function hasEvidenceKind(evidence: readonly EvidenceItem[], kind: string): boolean {
  return evidence.some((item) => item.kind === kind)
}

export function findMissingEvidenceKinds(
  evidence: readonly EvidenceItem[],
  requiredEvidenceKinds: readonly string[]
): string[] {
  return requiredEvidenceKinds.filter((kind) => !hasEvidenceKind(evidence, kind))
}

export function isWaiverEvidence(item: EvidenceItem): boolean {
  return item.kind === 'waiver'
}

export function getWaiverDetails(item: EvidenceItem): EvidenceDetails | undefined {
  if (!isWaiverEvidence(item)) {
    return undefined
  }

  return item.details
}
