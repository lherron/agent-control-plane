/**
 * PBC WorkflowPack manifest (Phase 2a, T-02347).
 *
 * This is the ONLY place PBC-specific ref strings appear. The manifest recognises
 * the `pbc-progressive-refinement@5` workflow and pins it by template hash when a
 * hash is supplied. The behavior slots (compilePrompt, parseParticipantOutput,
 * mapHumanInput, chooseTransition, project, workerPolicy) are intentionally left
 * undefined here — they are extracted from the existing pbc-* runtime files in
 * later sub-phases (2b–2d). For now this is a `supports()` shim only.
 */

import type { WorkflowPack, WorkflowPackSupport } from '../../runtime/workflow-pack.js'

/** The only workflow ref this pack claims. */
const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@5'

/**
 * Installed template hash for pbc-progressive-refinement@5, in the `sha256:<hex>`
 * format that `wrkf task inspect` returns in templateHash. When inspect supplies a
 * hash, it must match this pinned value; a mismatch means the template has been
 * modified or is unknown, so we degrade to manual/blocked (NOT best-effort).
 */
const KNOWN_TEMPLATE_HASH =
  'sha256:b107df7f136c707c48a10f58504e087812ea0e8025852540001f688885081680'

export const pbcManifest: WorkflowPack = {
  id: 'pbc',
  displayName: 'PBC Progressive Refinement',
  supports({ workflowRef, templateHash }): WorkflowPackSupport {
    if (workflowRef !== PBC_WORKFLOW_REF) {
      return { supported: false, level: 0 }
    }
    // Hash-pin guard fires only when a hash is supplied. A mismatch is treated as
    // manual/blocked (level 0), never best-effort — the compiled prompt, parser,
    // and transition policy cannot be trusted against an unknown template.
    if (templateHash !== undefined && templateHash !== KNOWN_TEMPLATE_HASH) {
      return { supported: false, level: 0, reason: 'template-hash-mismatch' }
    }
    return { supported: true, level: 3 }
  },
}
