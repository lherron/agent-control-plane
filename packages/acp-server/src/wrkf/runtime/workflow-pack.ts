/**
 * Generic WorkflowPack contract (Phase 2a, T-02347).
 *
 * A WorkflowPack adapts a specific family of workflow templates to the generic
 * wrkf runtime: it declares whether it supports a given workflow ref (and at what
 * support level), and optionally supplies behavior slots (prompt compilation,
 * participant-output parsing, human-input mapping, transition choice, projection,
 * worker policy) used by later sub-phases.
 *
 * This module MUST stay free of any pack-specific knowledge. Concrete packs live
 * under `src/wrkf/packs/<pack>/` and are the only place pack-specific strings
 * (template refs, domain vocabulary) may appear.
 */

/**
 * Support level for a resolved workflow.
 *
 *   0 — unsupported / manual: the runtime cannot trust pack behavior; degrade to
 *       inspect-only / human-driven handling.
 *   1 — best-effort: generic handling only.
 *   2 — partial: some pack behavior available.
 *   3 — full: the pack fully owns this workflow's behavior.
 */
export type WorkflowPackLevel = 0 | 1 | 2 | 3

/** Result of asking a pack (or the registry) whether a workflow is supported. */
export type WorkflowPackSupport = {
  supported: boolean
  level: WorkflowPackLevel
  reason?: string
  /**
   * True when the pack recognises the workflowRef, regardless of whether
   * hash/safety checks pass. Absent or false means the pack does not claim this
   * workflow. A claimed-but-unsupported result (claimed:true, supported:false)
   * is terminal: the registry MUST NOT fall through to later packs, preserving
   * fail-closed safety guards (e.g. template-hash mismatch).
   */
  claimed?: boolean
}

/** Input identifying a workflow to be matched against packs. */
export type WorkflowPackInput = {
  workflowRef: string
  workflowId?: string | undefined
  version?: string | undefined
  templateHash?: string | undefined
  template?: unknown
}

/** Placeholder slot signatures — concrete shapes are pinned in later sub-phases. */
export type CompilePromptFn = (input: unknown) => unknown
export type ParseParticipantOutputFn = (input: unknown) => unknown
export type MapHumanInputFn = (input: unknown) => unknown
export type ChooseTransitionFn = (input: unknown) => unknown
export type ProjectFn = (input: unknown) => unknown

/**
 * A pack adapting a workflow family to the generic runtime.
 *
 * `supports()` is required and pure. The remaining method slots are optional and
 * left undefined in Phase 2a; concrete packs fill them in during extraction
 * sub-phases (2b–2d).
 */
export type WorkflowPack = {
  id: string
  displayName: string
  supports(input: WorkflowPackInput): WorkflowPackSupport
  compilePrompt?: CompilePromptFn | undefined
  parseParticipantOutput?: ParseParticipantOutputFn | undefined
  mapHumanInput?: MapHumanInputFn | undefined
  chooseTransition?: ChooseTransitionFn | undefined
  project?: ProjectFn | undefined
  workerPolicy?: unknown
}
