export type PbcEvidenceSnapshot = {
  id: string
  kind: string
  facts?: Record<string, unknown>
  data?: Record<string, unknown>
}

export type PbcFreshnessResult = { blocked: false } | { blocked: true; reason: string }

const GUARDED_TRANSITIONS = new Set([
  'run_pressure_pass',
  'finalize_ready_pbc',
  'finalize_after_patch_decision',
])

export function checkPbcFreshness(input: {
  evidenceTimeline: PbcEvidenceSnapshot[]
  transition: string
}): PbcFreshnessResult {
  if (!GUARDED_TRANSITIONS.has(input.transition)) {
    return { blocked: false }
  }

  const window = currentRevisionWindow(input.evidenceTimeline)
  const currentDraft = latestOfKind(window, 'pbc_draft')

  if (currentDraft === undefined) {
    return {
      blocked: true,
      reason: 'pbc freshness blocked: no fresh pbc_draft after revision boundary',
    }
  }

  if (input.transition === 'run_pressure_pass') {
    return { blocked: false }
  }

  const currentPressurePass = latestOfKind(window, 'pressure_pass')
  if (currentPressurePass === undefined) {
    return {
      blocked: true,
      reason: 'pbc freshness blocked: no pressure_pass for current fresh draft',
    }
  }

  const reviewedDraftEvidenceId = stringField(currentPressurePass.data, 'reviewedDraftEvidenceId')
  if (reviewedDraftEvidenceId !== currentDraft.id) {
    return {
      blocked: true,
      reason: 'pbc freshness blocked: stale pressure_pass reviewed draft mismatch',
    }
  }

  if (input.transition === 'finalize_after_patch_decision') {
    const currentPatchDecision = latestOfKind(window, 'patch_decision')
    const currentPatchRoute = stringField(currentPatchDecision?.facts, 'route')
    if (currentPatchRoute !== 'finalize') {
      return {
        blocked: true,
        reason: 'pbc freshness blocked: no fresh patch_decision finalize after revise boundary',
      }
    }
  }

  const currentFinal = latestOfKind(window, 'pbc_final')
  if (currentFinal === undefined) {
    return { blocked: false }
  }

  const basedOnDraftEvidenceId = stringField(currentFinal.data, 'basedOnDraftEvidenceId')
  if (basedOnDraftEvidenceId !== currentDraft.id) {
    return {
      blocked: true,
      reason: 'pbc freshness blocked: stale pbc_final based draft mismatch',
    }
  }

  const basedOnPressurePassEvidenceId = stringField(
    currentFinal.data,
    'basedOnPressurePassEvidenceId'
  )
  if (basedOnPressurePassEvidenceId !== currentPressurePass.id) {
    return {
      blocked: true,
      reason: 'pbc freshness blocked: stale pbc_final based pressure_pass mismatch',
    }
  }

  return { blocked: false }
}

/**
 * Slice the evidence timeline down to the CURRENT revision window — everything
 * after the most recent revision boundary (a too_vague pressure_pass or a revise
 * patch_decision). Shared by the freshness gate and the PbcTaskProjection
 * artifacts builder so "latest eligible" draft/pressure/final stay in sync.
 */
export function currentRevisionWindow<T extends PbcEvidenceSnapshot>(timeline: T[]): T[] {
  let boundaryIndex = -1
  for (let index = 0; index < timeline.length; index++) {
    const evidence = timeline[index]
    if (evidence !== undefined && isRevisionBoundary(evidence)) {
      boundaryIndex = index
    }
  }
  return timeline.slice(boundaryIndex + 1)
}

function isRevisionBoundary(evidence: PbcEvidenceSnapshot): boolean {
  if (evidence.kind === 'pressure_pass') {
    return stringField(evidence.facts, 'verdict') === 'too_vague'
  }
  if (evidence.kind === 'patch_decision') {
    return stringField(evidence.facts, 'route') === 'revise'
  }
  return false
}

export function latestOfKind<T extends PbcEvidenceSnapshot>(
  timeline: T[],
  kind: string
): T | undefined {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const evidence = timeline[index]
    if (evidence?.kind === kind) {
      return evidence
    }
  }
  return undefined
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field]
  return typeof value === 'string' ? value : undefined
}
