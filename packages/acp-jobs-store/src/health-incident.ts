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
  const meta = run.metadata?.['meta']
  if (typeof meta !== 'object' || meta === null) return false
  const source = (meta as Record<string, unknown>)['source']
  if (typeof source !== 'object' || source === null) return false
  return (source as Record<string, unknown>)['kind'] === 'acp-health-incident'
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
  return {
    source: {
      kind: 'acp-health-incident',
      jobRunId: input.jobRunId,
      sourceEventId: input.sourceEventId,
      incidentTaskId: input.incidentTaskId,
    },
  }
}
