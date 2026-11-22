/**
 * Default WorkflowPackRegistry wiring (Phase 2a, T-02347).
 *
 * Builds the process-wide registry with all known packs registered. No packs ship
 * today (the PBC pack was removed in T-14375), so every workflow resolves to the
 * generic level-0 inspect/manual projection. Register concrete packs here; the
 * registry itself (runtime/) stays pack-agnostic.
 */

import { WorkflowPackRegistry } from '../runtime/workflow-pack-registry.js'

/** Construct a registry with the standard set of packs registered. */
export function createDefaultWorkflowPackRegistry(): WorkflowPackRegistry {
  const registry = new WorkflowPackRegistry()
  return registry
}

/** Process-wide default registry used by the task projection handler. */
export const defaultWorkflowPackRegistry = createDefaultWorkflowPackRegistry()
