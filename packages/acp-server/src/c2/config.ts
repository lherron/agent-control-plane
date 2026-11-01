/**
 * Per-instance configuration of the C2 mobile cards host (T-12207; wire law:
 * hrc-ios `architecture/contracts/C2_MOBILE_CARDS.md` r2.1).
 *
 * This is ordinary instance config, not a feature flag: the `/v1/mobile/c2/*`
 * routes always exist, behind the existing mobile gate. The scope allowlist is
 * NOT here — it is the HRC `ns c2, kind config, id scope` seat annotation on
 * the Vesta seat (C2 rev 4 D5), and an absent row allows nothing.
 */
export type AcpC2Config = {
  /** Vesta's seat scopeRef, e.g. `agent:vesta:project:c2:task:primary`. */
  vestaSeat: string
  /** This node's id as it appears in `home.node`, `seat.node` and receipts. */
  node: string
  /**
   * Artifact roots, resolved with realpath before containment checks. Default:
   * `~/praesidium/var/wrkq-artifacts` and `~/praesidium/var/scratch/c2`.
   */
  artifactRoots?: readonly string[] | undefined
  /** HRC observation cadence for the controller loop and long poll. */
  pollMs?: number | undefined
  /**
   * Bound on the one HRC literal-input call. Expiry after the call was made is
   * `unknown_outcome`, never `not_submitted`, and is never retried.
   */
  literalInputTimeoutMs?: number | undefined
}
