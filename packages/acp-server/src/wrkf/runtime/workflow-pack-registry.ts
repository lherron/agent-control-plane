/**
 * WorkflowPackRegistry (Phase 2a, T-02347).
 *
 * Generic routing layer: holds an ordered list of registered packs and resolves a
 * workflow input to the first pack whose `supports()` returns `supported: true`.
 * When no pack claims the input, resolution degrades to unsupported / level 0.
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
    }
    return { support: { ...UNSUPPORTED } }
  }
}
