/**
 * HRC marks late-projected historical rows with an evidence origin (today only
 * `'retained'`). They keep their original `ts` but get a fresh `hrcSeq`, so a
 * sequence-bounded reader would otherwise treat history as current output or
 * activity. Since T-13244 HRC emits the origin for any non-null value.
 */

/** True when a lifecycle event carries any evidence origin (history, never current work). */
export function hasHrcEvidenceOrigin(event: object): boolean {
  const origin = (event as { evidenceOrigin?: unknown }).evidenceOrigin
  return origin !== undefined && origin !== null
}
