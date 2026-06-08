/**
 * Delay applied when re-queuing an input that was rejected because the host
 * runtime was busy. Gives the in-flight run a brief window to settle before the
 * dispatcher retries.
 */
export const RUNTIME_BUSY_REQUEUE_DELAY_MS = 2_000

/**
 * Shared predicate for classifying "runtime busy" errors raised when a host
 * runtime already has an active run. Probes the structured error code as well
 * as legacy stringly-typed message variants.
 */
export function isRuntimeBusyError(error: unknown): boolean {
  const candidate = error as Record<string, unknown>
  return (
    candidate?.['code'] === 'runtime_busy' ||
    candidate?.['errorCode'] === 'runtime_busy' ||
    (error instanceof Error && error.message.toLowerCase().includes('runtime busy')) ||
    (error instanceof Error && error.message.toLowerCase().includes('active run'))
  )
}
