/**
 * Default WorkflowPackRegistry wiring (Phase 2a, T-02347).
 *
 * Builds the process-wide registry with all known packs registered. This is part
 * of the wiring layer (under packs/, not runtime/), so registering concrete packs
 * here is allowed. The registry itself (runtime/) stays pack-agnostic.
 */

import { WorkflowPackRegistry } from '../runtime/workflow-pack-registry.js'
import { pbcManifest } from './pbc/manifest.js'

/** Construct a registry with the standard set of packs registered. */
export function createDefaultWorkflowPackRegistry(): WorkflowPackRegistry {
  const registry = new WorkflowPackRegistry()
  registry.register(pbcManifest)
  return registry
}

/** Process-wide default registry used by the task projection handler. */
export const defaultWorkflowPackRegistry = createDefaultWorkflowPackRegistry()
