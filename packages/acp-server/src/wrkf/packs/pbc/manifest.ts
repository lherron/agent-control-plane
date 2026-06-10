/**
 * PBC WorkflowPack manifest (Phase 2a, T-02347).
 *
 * This is the ONLY place PBC-specific ref strings appear. The manifest recognises
 * the `pbc-progressive-refinement@9` workflow and pins it by template hash when a
 * hash is supplied. Pack behavior is wired here so the generic runtime can call
 * typed contracts without importing PBC-specific policy.
 */

import type { WorkflowPack, WorkflowPackSupport } from '../../runtime/workflow-pack.js'
import { mapPbcHumanInput, parsePbcParticipantOutput } from './output-parser.js'
import { choosePbcTransition } from './transition-policy.js'
import { pbcWorkerPolicy } from './worker-policy.js'

/** The only workflow ref this pack claims. */
const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@9'

/**
 * Installed template hash for pbc-progressive-refinement@9, in the `sha256:<hex>`
 * format that `wrkf task inspect` returns in templateHash. When inspect supplies a
 * hash, it must match this pinned value; a mismatch means the template has been
 * modified or is unknown, so we degrade to manual/blocked (NOT best-effort).
 */
const KNOWN_TEMPLATE_HASH =
  'sha256:b43c6ee33b5dfe565a97b35c63de77bd173c1457abd10076a8d755c0c32de148'

export const pbcManifest: WorkflowPack = {
  id: 'pbc',
  displayName: 'PBC Progressive Refinement',
  supports({ workflowRef, templateHash }): WorkflowPackSupport {
    if (workflowRef !== PBC_WORKFLOW_REF) {
      return { claimed: false, supported: false, level: 0 }
    }
    // This pack claims the ref regardless of hash outcome. The claim is what tells
    // the registry to treat any block as terminal rather than falling through.
    // Hash-pin guard fires only when a hash is supplied. A mismatch is treated as
    // manual/blocked (level 0), never best-effort — the compiled prompt, parser,
    // and transition policy cannot be trusted against an unknown template.
    if (templateHash !== undefined && templateHash !== KNOWN_TEMPLATE_HASH) {
      return { claimed: true, supported: false, level: 0, reason: 'template-hash-mismatch' }
    }
    return { claimed: true, supported: true, level: 3 }
  },
  parseParticipantOutput: parsePbcParticipantOutput,
  mapHumanInput: mapPbcHumanInput,
  needsEvidenceTimeline: true,
  chooseTransition: choosePbcTransition,
  workerPolicy: pbcWorkerPolicy,
}
