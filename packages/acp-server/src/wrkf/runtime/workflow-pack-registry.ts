/**
 * WorkflowPackRegistry (Phase 2a, T-02347).
 *
 * Generic routing layer: holds an ordered list of registered packs and resolves a
 * workflow input. The first pack whose `supports()` returns `supported: true`
 * wins. Otherwise, the first pack that *claims* the input (`claimed: true`) wins
 * even when it blocks it — its id and reason are surfaced and resolution stops
 * there (fail-closed: a claimed-but-blocked workflow MUST NOT fall through to a
 * later, more permissive pack). When no pack claims the input, resolution
 * degrades to anonymous unsupported / level 0.
 *
 * This module MUST stay free of any pack-specific knowledge — no hardcoded
 * template refs or domain vocabulary. Concrete packs are registered from the
 * wiring layer (see src/wrkf/packs/).
 */

import type { WorkflowPack, WorkflowPackInput, WorkflowPackSupport } from './workflow-pack.js'

export type WorkflowPackResolution = {
  pack?: WorkflowPack | undefined
  support: WorkflowPackSupport
}

const UNSUPPORTED: WorkflowPackSupport = { supported: false, level: 0 }

export class WorkflowPackRegistry {
  private readonly packs: WorkflowPack[] = []

  register(pack: WorkflowPack): void {
    this.packs.push(pack)
  }

  resolve(input: WorkflowPackInput): WorkflowPackResolution {
    for (const pack of this.packs) {
      const support = pack.supports(input)
      if (support.supported) {
        return { pack, support }
      }
      // First pack that claims the input but does not support it is terminal:
      // return it with its id + reason so a later, more permissive pack cannot
      // override the block (fail-closed). supported:true above still wins over a
      // bare claim from an earlier pack.
      if (support.claimed) {
        return { pack, support }
      }
    }
    return { support: { ...UNSUPPORTED } }
  }
}
