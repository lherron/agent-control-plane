import type { EvidenceDetails, EvidenceItem } from 'acp-core'

import { parseJsonRecord, stableStringify } from '../json.js'

export type EvidenceRow = {
  kind: string
  ref: string
  content_hash: string | null
  actor_slug: string
  produced_by_role: string
  build_id: string | null
  build_version: string | null
  build_env: string | null
  produced_at: string
  meta: string | null
}

export type EvidenceWriteRecord = {
  kind: string
  ref: string
  contentHash: string | null
  producedByActorUuid: string
  producedByRole: string
  buildId: string | null
  buildVersion: string | null
  buildEnv: string | null
  producedAt: string
  meta: string | null
}

export function mapEvidenceRow(row: EvidenceRow): EvidenceItem {
  const details = parseJsonRecord(row.meta) as EvidenceDetails | undefined

  return {
    kind: row.kind,
    ref: row.ref,
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    producedBy: {
      agentId: row.actor_slug,
      role: row.produced_by_role,
    },
    timestamp: row.produced_at,
    ...(row.build_id !== null || row.build_version !== null || row.build_env !== null
      ? {
          build: {
            ...(row.build_id !== null ? { id: row.build_id } : {}),
            ...(row.build_version !== null ? { version: row.build_version } : {}),
            ...(row.build_env !== null ? { env: row.build_env } : {}),
          },
        }
      : {}),
    ...(details !== undefined ? { details } : {}),
  }
}

export function mapEvidenceToWriteRecord(input: {
  evidence: EvidenceItem
  producedByActorUuid: string
  defaultTimestamp: string
  defaultRole: string
}): EvidenceWriteRecord {
  return {
    kind: input.evidence.kind,
    ref: input.evidence.ref,
    contentHash: input.evidence.contentHash ?? null,
    producedByActorUuid: input.producedByActorUuid,
    producedByRole: input.evidence.producedBy?.role ?? input.defaultRole,
    buildId: input.evidence.build?.id ?? null,
    buildVersion: input.evidence.build?.version ?? null,
    buildEnv: input.evidence.build?.env ?? null,
    producedAt: input.evidence.timestamp ?? input.defaultTimestamp,
    meta: input.evidence.details !== undefined ? stableStringify(input.evidence.details) : null,
  }
}
