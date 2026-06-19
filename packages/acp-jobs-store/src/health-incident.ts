/**
 * health-incident.ts — Health incident marker and predicate helpers.
 *
 * Types + stubs: T-04943 Phase B (RED).
 * Implementation: T-04943 Phase B execution.
 *
 * The marker stamps a fettle dispatch run's metadata so that the acp-health
 * loop guard (T-04939) can identify diagnostic runs WITHOUT relying on
 * agent/project/task name heuristics.
 */

/** Metadata shape stamped on a health-incident fettle dispatch run. */
export type HealthIncidentMeta = {
  source: {
    kind: 'acp-health-incident'
    jobRunId: string
    sourceEventId: string
    incidentTaskId: string
  }
}

/**
 * Returns true if the run was dispatched as an acp-health incident diagnostic.
 *
 * Keyed EXCLUSIVELY on metadata.meta.source.kind === 'acp-health-incident'.
 * NOT based on agent/project/task name heuristics.
 *
 * NOT YET IMPLEMENTED — always returns false until Phase B execution ships.
 * After implementation: read run.metadata?.['meta']?.['source']?.['kind'].
 */
export function isHealthDiagnosticRun(run: {
  metadata?: Readonly<Record<string, unknown>> | undefined
}): boolean {
  // TODO: Phase B — implement: return run.metadata?.['meta']?.['source']?.['kind'] === 'acp-health-incident'
  return false
}

/**
 * Build the health incident metadata object to stamp on a fettle dispatch run.
 *
 * NOT YET IMPLEMENTED — throws.
 */
export function buildHealthIncidentMeta(input: {
  jobRunId: string
  sourceEventId: string
  incidentTaskId: string
}): HealthIncidentMeta {
  // TODO: Phase B implementation
  throw new Error('buildHealthIncidentMeta: not implemented — T-04943 Phase B')
}
