# Refactor Analysis — `packages/acp-ops-projection`

Package-type profile: **data / projection** (pure transform of HRC lifecycle events into a
browser-safe dashboard contract). No concurrency, no I/O, one env read. The dominant invariant is
**field-set preservation**: the projection emits an exact DTO shape consumed across four packages,
so almost every change here is public-surface.

## Summary

`acp-ops-projection` is a single 984-line `src/index.ts` plus two contract test files. It is a
well-factored pure-functional projection: small helper functions, no shared mutable state, magic
numbers already named (`PRIORITY_*`, `DETAIL_CHAR_LIMIT`, `defaultRedactionOptions`), guard clauses
already in use, and a deliberate per-call env read documented in a comment. The make-safe rung is
already partly satisfied — `projection.red.test.ts` and `input-admission-labels.test.ts` pin the
public surface (family/severity mapping, id stability, redaction defaults, admission labels), but
they do not characterize `deriveSessionRow` field-by-field or `buildSummary` counts. There are
**few high-value refactors**; the package is mature. The findings that exist are low-risk internal
tidy-ups plus one genuine boundary observation (a redaction entry point exported but unused by
production consumers). Direction is mostly "leave alone" with a couple of small de-duplications; I
explicitly did **not** find premature abstraction to strip (`latestField<T>` has two real
instantiations) nor magic-number smells (already fixed).

## Public boundary (assessed first)

Verdict: **sound, with one needs-care note.**

The barrel exports (from `src/index.ts`):

- Types: `DashboardEventFamily`, `DashboardEventSeverity`, `SessionRef`, `DashboardEvent`,
  `SessionTimelineRow`, `SessionDashboardSummary`, `SessionDashboardSnapshot`, `RedactionOptions`,
  `HrcLifecycleEvent`.
- Values: `defaultRedactionOptions`, `projectHrcToDashboardEvent`, `deriveSessionRow`,
  `redactPayload`, `buildSummary`.
- Re-exports from `agent-action-render`: `admissionLabel`, `admissionLabelFromResponse`,
  `AdmissionLabelInput`.

Actual consumer usage (verified by grepping `from 'acp-ops-projection'` across `packages/`):

| Symbol | Consumers |
|---|---|
| `DashboardEvent` | acp-server, acp-ops-reducer, acp-viewer (types/store/mobile-adapter), tests |
| `SessionTimelineRow` | acp-server, acp-ops-reducer, acp-viewer |
| `SessionDashboardSnapshot` | acp-server (snapshot handler), acp-viewer (empty-snapshot, mobile-adapter) |
| `SessionDashboardSummary` | acp-viewer (use-reducer-store) |
| `DashboardEventFamily` | acp-server, acp-viewer (FamilyFilter) |
| `DashboardEventSeverity`, `SessionRef` | acp-viewer (re-exported via feature types) |
| `HrcLifecycleEvent` | acp-server (aliased `ProjectionHrcLifecycleEvent`), acp-viewer (mobile-adapter) |
| `projectHrcToDashboardEvent`, `deriveSessionRow`, `buildSummary` | acp-server, acp-viewer |
| `admissionLabel` | acp-server (aliased `centralAdmissionLabel`) |
| `admissionLabelFromResponse` | acp-cli (`send.ts`) |

Boundary observations:

1. **Every exported type is consumed somewhere** — the surface is not over-broad on types. Notably
   `SessionDashboardSnapshot` and `SessionDashboardSummary` are *type-only* contracts here: this
   package declares them but never constructs a full `SessionDashboardSnapshot` (only `buildSummary`
   produces a `SessionDashboardSummary`; the snapshot is assembled in acp-server). That is a
   deliberate "contract owner, not builder" split and is fine.
2. **`redactPayload` and `RedactionOptions`/`defaultRedactionOptions` are exported but only consumed
   by this package's own tests** — no production consumer imports them. They are public-by-test, not
   public-by-use. This is the one *needs-care* note: `redactPayload` is invoked internally by
   `projectHrcToDashboardEvent` (which IS consumed) so it is load-bearing, but its *standalone*
   export is currently speculative surface. Do not remove (the tests and the §16 redaction contract
   intentionally pin it as the security boundary), but be aware narrowing it would be a
   public-contract change. See finding F4.

No leaky internals are exported (helpers like `redactValue`, `deriveFamily`, `priorityFor` are
module-private). The barrel is clean.

## Findings by mechanism (outside-in)

### F1 — [T40] Characterization tests do not cover `deriveSessionRow` / `buildSummary` field set
- Location: `packages/acp-ops-projection/src/index.ts:890` (`deriveSessionRow`),
  `packages/acp-ops-projection/src/index.ts:953` (`buildSummary`); test gap in
  `packages/acp-ops-projection/test/projection.red.test.ts`.
- Technique: T40 characterization tests on the public surface (make-safe rung).
- Mechanism repaired: the projection's load-bearing invariant is the exact emitted field set of
  `SessionTimelineRow` (runtime/acp sub-objects, visualState priority ladder, stats) and the summary
  counts. Tests pin `projectHrcToDashboardEvent` family/severity/id and redaction, but only assert
  `rowId` for `deriveSessionRow` and never assert `buildSummary`. Any later refactor of the
  `buildRuntime`/`buildAcp`/`priorityFor` cluster could silently drop or add a field.
- Direction: add (tests only, no source change).
- Preservation rung: this is the rung that makes the rest safe; preserves behavior by definition.
- Falsifiable signal: a test that asserts a representative `deriveSessionRow` output (all
  runtime/acp fields populated) and `buildSummary` counts; mutate `assignDefined`/`priorityFor` and
  the assertion must break.
- Risk: Low. API-impact: internal-only (test addition). Effort: S.
- Tests: net-new; run `bun test` in the package.
- Contraindication: keep assertions field-explicit (object equality), not serialized blobs, so the
  "preserve exact field set" intent stays legible.

### F2 — [T15] Duplicated "is this a tool/message payload type" intent in `deriveFamily`
- Location: `packages/acp-ops-projection/src/index.ts:244-256` (inline `type === 'message_*'` /
  `type === 'tool_execution_*'` checks in `deriveFamily`) vs the already-extracted predicates
  `isToolType` (`src/index.ts:377`) and `isMessageType` (`src/index.ts:385`).
- Technique: T15 extract missing abstraction — here the abstraction *already exists*; this is reuse
  of an existing extraction, not a new one.
- Mechanism repaired: `deriveFamily` hand-inlines the same three-way `tool_execution_*` and
  `message_*` literal comparisons that `isToolType`/`isMessageType` encapsulate two screens down.
  The duplicated literal sets are a single-source-of-truth hazard: adding a fourth message subtype
  would require editing two places.
- Direction: relocate/dedup (replace the inline comparisons in `deriveFamily` with
  `isMessageType(type)` / `isToolType(type)`).
- Preservation rung: pure rename of an equivalent boolean expression; emitted family unchanged. The
  `message_*` arm has an extra `role === 'user'` branch — keep that branch, only collapse the
  three-literal disjunction into `isMessageType(type)`.
- Falsifiable signal: `projection.red.test.ts` family table (message_start/update/end,
  tool_execution_*) stays green unchanged.
- Risk: Low. API-impact: internal-only. Effort: S.
- Tests: existing red family table covers every arm.
- Contraindication: `isMessageType`/`isToolType` are defined *below* `deriveFamily`; function
  hoisting makes this fine (the file already relies on hoisting, e.g. `redactPayload` used in
  `projectHrcToDashboardEvent`). Confirm no lint rule forbids use-before-define.

### F3 — [T15] Repeated lowercase-substring `eventKind` matching scattered across derivers
- Location: `packages/acp-ops-projection/src/index.ts:232-239` (`eventKindIncludes`,
  `isRejectionKind`), plus open-coded `event.eventKind.toLowerCase()` + `.includes(...)` chains in
  `deriveRuntimeStatus` (`src/index.ts:618-636`), `isInputPending` (`src/index.ts:661-668`),
  `isDeliveryPending` (`src/index.ts:674-677`), `deriveSeverity` (`src/index.ts:311`).
- Technique: T15 extract missing abstraction (primitive obsession on lowercased event-kind tokens).
- Mechanism repaired: the same "lowercase the kind once, test membership against a token set"
  pattern is reimplemented per function. There is a latent abstraction — a normalized kind-token
  check — but it is *thinly* spread and the token lists legitimately differ per concern. Extracting a
  shared `kindMatchesAny(event, tokens)` removes repeated `.toLowerCase()` boilerplate without
  merging the (correctly distinct) token lists.
- Direction: extract (a small helper) — low value; the duplication is shallow.
- Preservation rung: pure helper, identical boolean results; no field-set impact.
- Falsifiable signal: family/severity red tables stay green; F1's status characterization stays green.
- Risk: Low. API-impact: internal-only. Effort: S.
- Tests: relies on F1 status coverage to be meaningful.
- Contraindication: **load-bearing variation** — do NOT unify the token lists themselves; each
  deriver's token set is its contract. Only the `.toLowerCase().includes` plumbing is dedup-safe.
  Borderline "leave alone"; listed for completeness.

### F4 — [T07] `redactPayload` + redaction options exported but unused by production consumers
- Location: `packages/acp-ops-projection/src/index.ts:937` (`redactPayload`),
  `packages/acp-ops-projection/src/index.ts:127` (`RedactionOptions`),
  `packages/acp-ops-projection/src/index.ts:134` (`defaultRedactionOptions`).
- Technique: T07 align interface to actual usage (candidate to narrow) — assessed and **declined**.
- Mechanism repaired (would-be): the public surface advertises a standalone redaction entry point
  that no other package imports; only the in-package `projectHrcToDashboardEvent` and the red tests
  use it. A strict reading says "narrow the export."
- Direction: none (hold). M02 Expand/Contract would be required to ever remove it, since it is a
  declared contract with a dedicated §16 test suite.
- Preservation rung: n/a (no change proposed).
- Falsifiable signal: n/a.
- Risk: High **if changed** (public-surface contract + security boundary). API-impact: public-surface.
  Effort: n/a.
- Tests: `projection.red.test.ts` "redaction red contract" block pins it.
- Contraindication: this is a deliberate security/contract seam (the §16 redaction defaults are the
  documented payload-safety guarantee for the browser dashboard). Removing or narrowing it is a
  redesign, not a refactor. Recorded so the surface decision is explicit and tracked.

### F5 — [T21] `buildRuntime` / `buildAcp` take a `latest` event plus an ordered list (data clump)
- Location: `packages/acp-ops-projection/src/index.ts:841` (`buildRuntime(orderedEvents, latest,
  status)`), `packages/acp-ops-projection/src/index.ts:870` (`buildAcp(orderedEvents, latest,
  deliveryPending)`), called from `deriveSessionRow` (`src/index.ts:905-906`).
- Technique: T21 introduce parameter object — assessed and **declined** (param count is 3, under the
  >4 threshold).
- Mechanism repaired (would-be): both builders take `(orderedEvents, latest, extra)` where `latest`
  is derivable from `orderedEvents` (`orderedEvents.at(-1)`), so `latest` is a mild data clump.
- Direction: none (hold). Dropping `latest` would recompute `at(-1)` and `deriveSessionRow` already
  holds `latest` for its own use, so passing it down is cheaper and clearer.
- Preservation rung: n/a.
- Falsifiable signal: n/a.
- Risk: Low. API-impact: internal-only. Effort: n/a.
- Contraindication: passing the already-computed `latest` is intentional (it is the fallback source
  for `runtimeId`/`activeRunId`/`lastActivityAt`). Leave as-is.

## Deliberately left alone (where-NOT)

- **`latestField<T>` generic (`src/index.ts:582`)** — NOT premature abstraction (T16 declined). Two
  real instantiations (`latestString` via `eventString`, `latestBoolean` via `eventBoolean`); the
  variation has materialized. Keep.
- **`assignDefined<T,K>` (`src/index.ts:605`)** — NOT collapse-worthy. It encapsulates the
  load-bearing "undefined fields are never emitted" projection invariant (documented in its comment)
  and is used ~14 times. Inlining would re-spread the exact thing it centralizes. Keep.
- **Magic numbers** — already named: `PRIORITY_*` ladder (`src/index.ts:735-741`),
  `DETAIL_CHAR_LIMIT` (`src/index.ts:329`), `defaultRedactionOptions` (`src/index.ts:134`);
  `60_000`/`90_000` window math is local and clear. No T15 here.
- **Per-call env read `rawPayloadDebugFromEnv` (`src/index.ts:464`)** — NOT a substitution-seam
  violation. The comment explicitly documents reading per-call (not module-load) so long-lived
  processes can toggle `ACP_DASHBOARD_RAW_PAYLOAD` at runtime. Deliberate; keep.
- **`deriveFamily` / `deriveSeverity` if-ladders** — NOT a T19 conditional→dispatch candidate. These
  are priority-ordered classification ladders over heterogeneous signals (payload type, errorCode,
  category, eventKind prefixes), not a one-arm-per-type switch. A dispatch table would lose the
  ordering semantics. Keep as ordered guard ladders.
- **`transport` bespoke narrowing in `buildRuntime` (`src/index.ts:859`)** — kept its own
  `=== 'tmux' || 'sdk'` guard rather than `assignDefined`, by design (it validates the union, not
  just definedness). The comment says so. Keep.
- **`redactValue` recursion with `WeakSet` seen-set (`src/index.ts:488`)** — correct circular-ref
  handling and depth/array bounding; no T31/T32 (single-threaded, fresh `WeakSet` per
  `redactPayload` call). Keep.

## If applying: outside-in sequence

1. F1 first (make-safe): add field-explicit characterization tests for `deriveSessionRow` and
   `buildSummary`. Gates everything below.
2. F2: collapse the inline tool/message type checks in `deriveFamily` to `isToolType`/`isMessageType`.
   Run `bun test`.
3. F3 (optional, low value): extract the `.toLowerCase().includes` plumbing helper only — keep token
   lists per-deriver. Run `bun test`. Skip if it does not net-reduce line count meaningfully.
4. F4/F5: no action (recorded as deliberate holds).

## Safety checklist

- [ ] `bun test` green in `packages/acp-ops-projection` (red family/severity/redaction/admission
      contracts unchanged).
- [ ] `bun run typecheck` (`tsc --noEmit`) clean.
- [ ] No change to the emitted field set of `DashboardEvent`, `SessionTimelineRow`,
      `SessionDashboardSummary` (verify via F1 assertions).
- [ ] Downstream typecheck unaffected: acp-server (`ops-dashboard-shared.ts`), acp-ops-reducer,
      acp-viewer, acp-cli (`send.ts`).
- [ ] No public export added/removed/narrowed (F4 held deliberately).
- [ ] biome/lint clean — F2 must not trip `useValidTypeof` (it manipulates string literals, not
      `typeof`), and confirm use-before-define is tolerated (file already relies on hoisting).
