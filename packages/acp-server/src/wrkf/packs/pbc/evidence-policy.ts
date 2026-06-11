/**
 * PBC evidence policy — pack-specific validation + submission gates injected into
 * the generic evidence writer (src/wrkf/runtime/evidence-writer.ts).
 *
 * SPEC §4.9 / §4.10. This is the ONLY place that names PBC evidence kinds and
 * facts. The generic runtime writer stays pack-free and consumes this policy via
 * the structural EvidenceWritePolicy hook.
 *
 * Responsibilities:
 *   - Validate participant-produced facts against the known PBC evidence kinds.
 *   - PRODUCT-OWNER FABRICATION GATE (security-critical): the agent role MUST NOT
 *     synthesize product_owner obligation evidence (clarification_response /
 *     patch_decision) unless allowProductOwnerSimulation is explicitly enabled.
 *     This invariant lives in the pack and must never be weakened.
 *   - Permit obligation satisfaction by kind lookup.
 */

import type { EvidenceWritePolicy, ParticipantOutput } from '../../runtime/evidence-writer.js'
import { PRODUCT_OWNER_EVIDENCE_KINDS } from './prompt-compiler.js'

// ---------------------------------------------------------------------------
// Fact validation (SPEC §4.9 required facts)
// ---------------------------------------------------------------------------

const PRESSURE_VERDICTS = ['ready', 'needs_patch', 'too_vague']
const PATCH_ROUTES = ['finalize', 'revise']
const DISPOSITION_RESOLUTIONS = ['wont_fix', 'duplicate', 'unclear', 'out_of_scope']

/**
 * Validate participant-produced evidence facts against the known PBC evidence
 * kinds. Throws on the first invalid record. wrkf remains authoritative and may
 * still reject; this is a best-effort pre-flight check.
 */
export function validateParticipantOutputFacts(output: ParticipantOutput): void {
  for (const evidence of output.evidence) {
    const facts = evidence.facts
    switch (evidence.kind) {
      case 'pre_interview_analysis': {
        if (facts !== undefined && 'clarification_needed' in facts) {
          if (typeof facts['clarification_needed'] !== 'boolean') {
            throw new Error('pre_interview_analysis.facts.clarification_needed must be a boolean')
          }
        }
        break
      }
      case 'pressure_pass': {
        const verdict = facts?.['verdict']
        if (typeof verdict !== 'string' || !PRESSURE_VERDICTS.includes(verdict)) {
          throw new Error(
            `pressure_pass.facts.verdict must be one of: ${PRESSURE_VERDICTS.join(', ')}`
          )
        }
        break
      }
      case 'patch_decision': {
        const route = facts?.['route']
        if (typeof route !== 'string' || !PATCH_ROUTES.includes(route)) {
          throw new Error(`patch_decision.facts.route must be one of: ${PATCH_ROUTES.join(', ')}`)
        }
        break
      }
      case 'disposition_decision': {
        const resolution = facts?.['resolution']
        if (typeof resolution !== 'string' || !DISPOSITION_RESOLUTIONS.includes(resolution)) {
          throw new Error(
            `disposition_decision.facts.resolution must be one of: ${DISPOSITION_RESOLUTIONS.join(', ')}`
          )
        }
        break
      }
      default:
        // Other kinds carry no required facts.
        break
    }
  }
}

/**
 * PRODUCT-OWNER FABRICATION GATE (security-critical).
 *
 * Reject any attempt by the agent role to synthesize product_owner obligation
 * evidence (e.g. clarification_response / patch_decision) unless product-owner
 * simulation is explicitly enabled. Throws on the first offending record.
 */
export function assertNoProductOwnerFabrication(
  output: ParticipantOutput,
  role: string,
  allowProductOwnerSimulation: boolean | undefined
): void {
  if (role === 'agent' && allowProductOwnerSimulation !== true) {
    const offending = output.evidence.find((e) => PRODUCT_OWNER_EVIDENCE_KINDS.includes(e.kind))
    if (offending !== undefined) {
      throw new Error(
        `Agent role must not synthesize product_owner obligation evidence (kind "${offending.kind}") unless allowProductOwnerSimulation is enabled.`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Policy factory — wires the PBC gates into the generic writer.
// ---------------------------------------------------------------------------

export interface PbcEvidencePolicyOptions {
  allowProductOwnerSimulation?: boolean
}

export function makePbcEvidencePolicy(options: PbcEvidencePolicyOptions = {}): EvidenceWritePolicy {
  return {
    validate(output, ctx) {
      // 1. Product-owner fabrication gate (before any write).
      assertNoProductOwnerFabrication(output, ctx.role, options.allowProductOwnerSimulation)
      // 2. Best-effort fact validation before sending anything to wrkf.
      validateParticipantOutputFacts(output)
    },
    // PBC permits satisfying obligations by kind lookup when no explicit id.
    allowObligationKindLookup: true,
  }
}
