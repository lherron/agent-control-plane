/**
 * Per-instance configuration of the C2 mobile cards host (T-12207; wire law:
 * hrc-ios `architecture/contracts/C2_MOBILE_CARDS.md` r2.1).
 *
 * This is ordinary instance config, not a feature flag: the `/v1/mobile/c2/*`
 * routes always exist, behind the existing mobile gate. The scope allowlist is
 * NOT here — it is the HRC `ns c2, kind config, id scope` seat annotation on
 * the Vesta seat (C2 rev 4 D5), and an absent row allows nothing.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AcpC2Config = {
  /** Vesta's seat scopeRef, e.g. `agent:vesta:project:c2:task:primary`. */
  vestaSeat: string
  /**
   * This node's id as it appears in `home.node`, `seat.node` and receipts.
   * Default: HRC's declared `status.node.nodeId`.
   */
  node?: string | undefined
  /**
   * Artifact roots, resolved with realpath before containment checks. Default:
   * `~/praesidium/var/wrkq-artifacts` and `~/praesidium/var/scratch/c2`.
   */
  artifactRoots?: readonly string[] | undefined
  /** Fast HRC observation cadence (Vesta, in-scope seats, seats with c2 rows). */
  pollMs?: number | undefined
  /** Full seat sweep cadence: which continuities hold c2 rows or match scope. */
  sweepMs?: number | undefined
  /**
   * Bound on the one HRC literal-input call. Expiry after the call was made is
   * `unknown_outcome`, never `not_submitted`, and is never retried.
   */
  literalInputTimeoutMs?: number | undefined
  /** The controller's settle window after a start or remount (c2-core default 30 s). */
  settleMs?: number | undefined
  /** Unreviewed age before the review wake (card contract §4a; c2-core default 60 s). */
  reviewAfterMs?: number | undefined
  /** Receipt grace before recovery acts (§6; c2-core default 60 s). */
  graceMs?: number | undefined
}

export const C2_DEFAULTS = {
  pollMs: 2000,
  sweepMs: 60_000,
  literalInputTimeoutMs: 30_000,
} as const

export function defaultArtifactRoots(): string[] {
  const root = join(homedir(), 'praesidium', 'var')
  return [join(root, 'wrkq-artifacts'), join(root, 'scratch', 'c2')]
}
