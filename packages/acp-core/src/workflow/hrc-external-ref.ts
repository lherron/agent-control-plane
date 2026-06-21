/**
 * Shared parser/formatter for the wrkf external-ref form of HRC run ids.
 *
 * wrkf stores HRC launches under the external ref `hrc:<bare HRC runId>`.
 * HRC's own APIs (getRun/listRuns) accept only the BARE runId. This module
 * owns the single conversion between those two forms so consumers never
 * hand-strip or hand-add the `hrc:` prefix independently.
 *
 * Direction of travel:
 *   - HRC launch  -> wrkf storage: formatHrcExternalRef(bareRunId) => 'hrc:<id>'
 *   - wrkf lookup -> HRC call:     parseHrcExternalRef('hrc:<id>') => '<id>'
 *
 * Non-HRC schemes (e.g. `webhook:abc`, `s3:bucket/key`) are NOT claimed or
 * transformed by this module — see isHrcExternalRef.
 */

/** The scheme prefix wrkf uses to store HRC run ids as external refs. */
export const HRC_EXTERNAL_REF_PREFIX = 'hrc:'

/**
 * Formatter for HRC launches: bare HRC runId -> prefixed wrkf external ref.
 *
 * Trims input. Throws on empty/whitespace input. Throws if the input is
 * ALREADY prefixed with `hrc:` — a bare id is required here, so passing a
 * prefixed id is a caller bug.
 *
 * formatHrcExternalRef('run-123') === 'hrc:run-123'
 */
export function formatHrcExternalRef(bareRunId: string): string {
  const trimmed = bareRunId.trim()
  if (trimmed.length === 0) {
    throw new Error('formatHrcExternalRef: bare HRC runId is required (received empty/whitespace)')
  }
  if (trimmed.startsWith(HRC_EXTERNAL_REF_PREFIX)) {
    throw new Error(
      `formatHrcExternalRef: expected a bare HRC runId but received an already-prefixed ref ${JSON.stringify(
        trimmed
      )}; pass the bare id without the '${HRC_EXTERNAL_REF_PREFIX}' scheme`
    )
  }
  return `${HRC_EXTERNAL_REF_PREFIX}${trimmed}`
}

/**
 * Parser for HRC calls: prefixed wrkf external ref -> bare HRC runId.
 *
 * Trims input. Throws if the ref is not an `hrc:`-scheme ref, or if the bare
 * remainder is empty.
 *
 * parseHrcExternalRef('hrc:run-123') === 'run-123'
 */
export function parseHrcExternalRef(externalRunRef: string): string {
  const trimmed = externalRunRef.trim()
  if (!trimmed.startsWith(HRC_EXTERNAL_REF_PREFIX)) {
    throw new Error(
      `parseHrcExternalRef: expected an '${HRC_EXTERNAL_REF_PREFIX}' scheme ref but received ${JSON.stringify(
        externalRunRef
      )}`
    )
  }
  const bare = trimmed.slice(HRC_EXTERNAL_REF_PREFIX.length).trim()
  if (bare.length === 0) {
    throw new Error(
      `parseHrcExternalRef: external ref ${JSON.stringify(
        externalRunRef
      )} has an empty bare HRC runId`
    )
  }
  return bare
}

/**
 * Predicate: does this external ref use the `hrc:` scheme?
 *
 * Returns false for non-HRC schemes (e.g. `webhook:abc`, `s3:bucket/key`) and
 * for bare ids with no scheme. Does not validate the bare remainder.
 *
 * isHrcExternalRef('hrc:x') === true
 * isHrcExternalRef('webhook:abc') === false
 * isHrcExternalRef('x') === false
 */
export function isHrcExternalRef(externalRunRef: string): boolean {
  return externalRunRef.trim().startsWith(HRC_EXTERNAL_REF_PREFIX)
}
