export const WRKQ_CAUSATION_REF_ENV = 'WRKQ_CAUSATION_REF'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCausationRefFromSource(source: unknown): string | undefined {
  if (!isRecord(source)) {
    return undefined
  }
  const causationRef = source['causationRef']
  return typeof causationRef === 'string' && causationRef.trim().length > 0
    ? causationRef.trim()
    : undefined
}

export function causationRefFromInputMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  return metadata === undefined ? undefined : readCausationRefFromSource(metadata['source'])
}

export function causationRefFromRunMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const meta = isRecord(metadata?.['meta']) ? metadata['meta'] : undefined
  return causationRefFromInputMetadata(meta)
}

export function causationLaunchEnvFromInputMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): Record<string, string> | undefined {
  const causationRef = causationRefFromInputMetadata(metadata)
  return causationRef === undefined ? undefined : { [WRKQ_CAUSATION_REF_ENV]: causationRef }
}

export function causationLaunchEnvFromRunMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): Record<string, string> | undefined {
  const causationRef = causationRefFromRunMetadata(metadata)
  return causationRef === undefined ? undefined : { [WRKQ_CAUSATION_REF_ENV]: causationRef }
}
