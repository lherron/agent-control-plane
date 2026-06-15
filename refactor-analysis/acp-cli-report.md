# Refactor Analysis — `packages/acp-cli`

Package-type profile: **general (CLI / thin HTTP wrapper)**. No concurrency-shared-state, no
data-store ownership, no perf hot loop worth swapping. Leaf-ish but NOT a leaf: it has one real
consumer surface (`src/index.ts` re-exports `createHttpClient`, `AcpClient`, `normalizeScopeInput`,
error classes) imported by sibling packages, so M02 Expand/Contract DOES apply to public-surface
changes. The `acp` binary itself is a behavior surface gated by characterization tests.

All ~70 source files under `src/` were read in full.

---

## Summary

`acp-cli` is a Commander-driven operator CLI over `acp-server`. The architecture is clean in the
large: a top-level `cli.ts` wires Commander option trees, every leaf re-serializes parsed Commander
options back into a `string[]` (`legacyArgs`) and hands them to a per-command `run*Command(args,
deps)` function that re-parses them with a hand-rolled `parseArgs`. Commands share a `shared.ts`
helper layer (env/actor/server resolution, two HTTP requester factories, output wrappers).

The dominant smells are **boundary over-surface** (the typed `AcpClient` interface carries three
methods no command calls, two of which throw "removed") and **copied small helpers** (`normalizeActorId`
x4, `asRecord`/`stringField` x3–4, delivery-ref parsing x2, the `request`/`doFetch` HTTP core x2).
There is also confirmed **dead rendering code** in `output/task-render.ts` (4 of 5 exports unused).
The `legacyArgs` double-parse (Commander → string[] → parseArgs) is a deliberate compatibility seam,
not an accident — flagged but contraindicated against collapsing.

Most findings are internal-only, low/medium risk, and behavior-preserving. The public-boundary
findings (trimming the `AcpClient` interface) are the highest-leverage but require M02 because the
interface is exported and stubbed by external/test fakes.

---

## Public boundary — assess first

`src/index.ts` exports:
- `main` (CLI entry)
- `normalizeScopeInput`
- `createHttpClient`, `DEFAULT_ACP_SERVER_URL`, `AcpClientHttpError`, `AcpClientTransportError`
- types: `AcpClient`, `AcpErrorBody`, `FetchLike`, `GetTaskResponse`, `TaskContext`,
  `TaskTransitionResponse`

`package.json` exports `.` → `dist/index.js` (and `bun` → `src/index.ts`).

**Verdict: needs-care.**

The export *set* is reasonable and narrow. The problem is one exported member — the `AcpClient`
interface — is wider than its actual usage:

- `createTask(...)` is fully implemented but **no CLI command calls it** (there is no `acp task create`
  command in `cli.ts`). Only test fakes reference it.
- `promoteTask(...)` is declared and its implementation unconditionally throws
  `'legacy task promote route has been removed'`. No caller.
- `listTransitions(...)` likewise throws `'legacy task transitions route has been removed'`. No caller.

`TaskContext` is exported from `index.ts` but the only consumer of the type inside this package
(`output/task-render.ts renderTask`) is itself dead code (see Findings). It may have an external
consumer — must be confirmed before removal.

`createHttpClient` / `AcpClient` are genuinely consumed by `seed/seed-agent-profiles.ts` (in-process
fetch) and re-exported for siblings, so they are load-bearing — but only the methods the seeder and
commands actually use (`listAgents`, `patchAgentProfile`, `getTask`, `transitionTask`, evidence /
obligation / interface-binding / agent-pulpit / governance methods). The three dead methods are pure
surface tax and a maintenance trap (each test fake must stub all three).

---

## Findings by mechanism (outside-in)

### A. Make-safe (gates everything)

#### F1 — [T40] Characterization tests on the CLI surface before any interface trim
- **Location:** `test/cli-help.test.ts`, `test/integration.test.ts`, `test/commands/*.test.ts`
  (existing); gap = no test asserts the *shape* of the exported `AcpClient` (tests stub it, they
  don't pin it).
- **Mechanism repaired:** missing executable spec for the public boundary — without it, narrowing
  `AcpClient` is unverifiable.
- **Direction:** add (test only).
- **Preservation rung:** N/A (adds coverage).
- **Falsifiable signal:** a test that constructs `createHttpClient()` and asserts the method set, plus
  a grep-guard that `createTask|promoteTask|listTransitions` are unreferenced by `src/commands`.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** this IS the test.
- **Contraindication:** none.

### B. Boundary (highest leverage)

#### F2 — [T07]+[M02] Narrow the `AcpClient` interface to actual usage (drop `promoteTask`, `listTransitions`; decide `createTask`)
- **Location:** `src/http-client.ts:178-187` (`promoteTask`), `:230` (`listTransitions`),
  `:160-177` + `:444-462` (`createTask`); the throwing impls at `:464-466` and `:551-553`.
- **Mechanism repaired:** interface wider than usage — three methods, two of which are permanently
  `throw`. This is partial/total inversion *and* dead surface; every external/test fake (6 test files)
  must stub all three.
- **Direction:** remove (`promoteTask`, `listTransitions`); investigate-then-remove-or-keep
  (`createTask`).
- **Preservation rung:** Expand/Contract (M02): the interface is exported, so add-nothing /
  deprecate-then-remove. Because the methods only throw, removing them is observably behavior-preserving
  for any real caller (a real caller would already crash); the only "consumers" are test stubs.
- **Falsifiable signal:** after removal, `bun test` passes once the 6 fakes drop the three stub
  entries; `grep -r 'promoteTask\|listTransitions' src` returns nothing.
- **Risk:** Med · **API-impact:** public-surface · **Effort:** M · **Tests:** F1 + existing fakes.
- **Contraindication:** `createTask` is implemented (not throwing) and could be a deliberate
  library-only entry point for an external consumer — do NOT remove it without confirming no sibling
  package imports it. Treat `createTask` as a separate, lower-confidence sub-item.

#### F3 — [T16] Remove dead rendering exports in `output/task-render.ts`
- **Location:** `src/output/task-render.ts` — `renderTask` (`:12`), `renderCreatedTask` (`:44`),
  `renderCreatedWorkflowTask` (`:56`), `renderPromotedTask` (`:91`), plus the `renderRoleMap`/`Task`
  /`TaskContext` machinery they pull in. Only `renderWorkflowTask` (`:70`) is imported (by
  `commands/task-show.ts:1`).
- **Mechanism repaired:** dead abstraction — four exported renderers (and the legacy `Task` type
  surface) with zero references in `src` or `test`.
- **Direction:** remove.
- **Preservation rung:** drop-old (these are unreferenced leaves inside the package).
- **Falsifiable signal:** `grep -rn 'renderTask\|renderCreatedTask\|renderPromotedTask\|renderCreatedWorkflowTask' src test`
  returns only the definitions; after deletion build + tests stay green.
- **Risk:** Low · **API-impact:** internal-only (none of these are re-exported from `index.ts`) ·
  **Effort:** S · **Tests:** build + existing task-show test.
- **Contraindication:** confirm `TaskContext` (exported from index) has no external consumer before
  removing the `Task`-shaped renderers that reference it; the type can stay even if the renderers go.

### C. Seams & structure

#### F4 — [T15] Extract `normalizeActorId` (the `agent:`-prefix strip) into one shared helper
- **Location:** identical `function normalizeActorId` in `commands/task-run.ts:23-29`,
  `commands/task-transition.ts:25-31`, `commands/task-evidence-add.ts:25-31`, and inlined inside
  `commands/task-run-complete.ts:30-34` (`resolveActorFromAs`).
- **Mechanism repaired:** duplicated intent (strip `agent:` prefix, trim) copied 4×. Natural home:
  `commands/session-shared.ts` or `commands/shared.ts` next to `resolveOptionalActorAgentId`.
- **Direction:** relocate/extract.
- **Preservation rung:** identity refactor — same string output.
- **Falsifiable signal:** one exported `normalizeActorId`; the 4 copies become imports; actor-alias
  tests (`test/commands/actor-alias.test.ts`) stay green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** actor-alias + task-run/
  transition/evidence tests.
- **Contraindication:** none.

#### F5 — [T15] Consolidate `asRecord` / `stringField` JSON-narrowing helpers
- **Location:** `asRecord` defined in `hrc-store-reader.ts:56`, `output/timeline-project.ts:99`,
  `output/hrc-event-to-row.ts:15`, `output/timeline-hrc-join.ts:44`; `stringField` defined in
  `output/timeline-project.ts:105`, `output/hrc-event-to-row.ts:21`, `output/timeline-hrc-join.ts:50`.
  All byte-identical.
- **Mechanism repaired:** primitive-obsession scaffolding duplicated across the timeline/output
  cluster. Natural home: a small `output/json-narrow.ts` (or reuse from `acp-core` if it already
  exports equivalents — check first).
- **Direction:** extract + relocate.
- **Preservation rung:** identity refactor.
- **Falsifiable signal:** single definition each; timeline-project / timeline-render / hrc-event-to-row
  tests stay green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** `__tests__/timeline-*`,
  `hrc-event-to-row.test.ts`, `hrc-store-reader.test.ts`.
- **Contraindication:** keep `hrc-store-reader.ts` self-contained if you want it dependency-free of
  output/* — acceptable to leave its copy; the 3 output-module copies are the clear win.

#### F6 — [T15] De-duplicate delivery-ref JSON parsing
- **Location:** `output/timeline-project.ts:194` (`parseDeliveryRef`) and
  `output/timeline-hrc-join.ts:136` (`tryParseDeliveryRef`) — same logic, same return shape
  (`{scopeRef?, laneRef?}`), different names.
- **Mechanism repaired:** duplicated parse-with-fallback intent across two timeline modules.
- **Direction:** extract to a shared timeline helper, single name.
- **Preservation rung:** identity refactor; **must preserve the exact `{scopeRef, laneRef}` field set**
  (both currently spread conditionally — keep that).
- **Falsifiable signal:** one exported parser; `timeline-hrc-join` and `timeline-project` tests green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** `timeline-hrc-join.test.ts`,
  `timeline-project.test.ts`, `wrkf-cli-consumers.test.ts`.
- **Contraindication:** none.

#### F7 — [T23]/[T15] Collapse the two near-identical HTTP request cores
- **Location:** `http-client.ts:406-441` (`request<T>` inside `createHttpClient`) vs
  `commands/shared.ts:120-172` (`createRawAcpRequester` `doFetch` + `requestJson`/`requestText`).
  Both: build `Headers`, set content-type on body, set `x-acp-actor-agent-id`, prefix `baseUrl`,
  wrap network failure in `AcpClientTransportError`, parse body, throw `AcpClientHttpError` on
  `!ok`. The raw requester additionally accepts caller `headers` and a text variant.
- **Mechanism repaired:** the typed client's `request` is a strict subset of the raw requester. Two
  copies of the transport/error contract drift independently. The raw requester is the dominant path
  (most commands use it); the typed `AcpClient.request` is the minority path.
- **Direction:** isolate — have `createHttpClient`'s internal `request` delegate to a shared
  low-level fetch core (the raw requester's `doFetch`/`requestJson`), or extract a single
  `acpFetchJson` primitive both build on.
- **Preservation rung:** identity refactor — same headers, same error types, same body parsing.
  Verify header-set ordering and the `content-type` only-when-body rule are preserved exactly.
- **Falsifiable signal:** one transport core; all http-client + command tests
  (`http-client-agent-profile.test.ts`, `integration.test.ts`) green; transport-error and
  http-error paths still throw the same classes.
- **Risk:** Med · **API-impact:** internal-only (public types unchanged) · **Effort:** M ·
  **Tests:** http-client, integration, and any per-command requester test.
- **Contraindication:** the two paths have slightly different feature sets (raw requester supports
  caller-supplied `headers` and a text response; typed client does not). Unify *downward* (typed
  client uses the richer core) — do not strip the raw requester's extra capability.

#### F8 — [T16] (where-NOT, documented) The `legacyArgs` Commander→string[]→parseArgs round-trip
- **Location:** `cli.ts:93-154` (`legacyArgs`, `runLeaf`, `runLeafWithPositionals`) feeding
  `parseArgs` in every `commands/*`.
- **Observation:** Commander already parses options; `legacyArgs` re-serializes them to a flag array
  that each command re-parses with the bespoke `parseArgs`. This is a textbook middle-man / premature
  double-parse.
- **Why left alone:** this is a **deliberate compatibility seam** — every `run*Command` is also a
  directly-callable, Commander-independent entry point exercised by `test/commands/*` (they pass raw
  `string[]`). Collapsing it would couple commands to Commander's `OptionValues` and rewrite the
  entire test suite. The duplication is load-bearing (it preserves the "command = pure
  `(args,deps)=>output`" testability contract). Flagged for awareness, **not** proposed for change.

### D. Invariants

#### F9 — [T17] (low-priority) `parseArgs` `typeof` literal duplication risk — do NOT parameterize
- **Location:** `commands/options.ts` flag-kind branches.
- **Observation considered and rejected:** there is a temptation to parameterize the boolean/string/
  multi-string flag handling further, but the current explicit branches are clear and a `typeof`-style
  dedup here would risk a biome `useValidTypeof`/readability regression for no behavioral gain. Left
  alone deliberately.

### E. Quality

#### F10 — [T18] Tighten the swallowed-catch in the HRC store join path (review, likely keep)
- **Location:** `commands/task-timeline.ts:276-283` — `catch {}` around `joinHrcTimeline` converts any
  HRC-store failure into a soft "rendering ACP-only" warning.
- **Mechanism considered:** broad `catch{}` hides programming errors as well as the intended
  "store unreachable" case.
- **Direction:** narrow (catch only the store-open/IO error type, rethrow unexpected).
- **Preservation rung:** behavior-preserving only if narrowed to the same observable set; widening what
  propagates is a behavior change.
- **Falsifiable signal:** an injected non-IO error now surfaces instead of being swallowed; the
  store-missing test still produces the warning.
- **Risk:** Med · **API-impact:** internal-only · **Effort:** S.
- **Contraindication:** STRONG — this is an intentional graceful-degradation seam for an *optional*
  enrichment (the timeline must render even with no/broken HRC store). Narrowing it could regress the
  "never fail the timeline" guarantee. Recommend leaving as-is unless a real masked bug is found.
  Listed for completeness; **not** auto-applicable.

---

## Deliberately left alone (where-NOT)

- **`legacyArgs` double-parse (F8):** deliberate testability seam; load-bearing duplication.
- **`task-timeline` `catch {}` (F10):** intentional graceful-degradation; narrowing risks behavior.
- **`parseArgs` branch structure (F9):** clear as-is; dedup would trip lint / reduce readability.
- **`hrc-store-reader.ts` private `asRecord`:** acceptable to keep so the store reader stays free of
  `output/*` deps; only the 3 output-module copies are worth merging (F5).
- **`createHttpClient` / `AcpClient` core methods actually used by commands & seeder:** load-bearing,
  not surface tax — only the 3 dead methods (F2) are the target.
- **`server-runtime.ts` lifecycle/launchctl logic:** large but cohesive, single-responsibility
  (process supervision); no duplication worth extracting and high behavioral risk — leave.
- **Per-command `renderTable` column arrays:** look duplicative but each column set is genuinely
  command-specific (different fields); parameterizing would be premature abstraction.

---

## If applying: outside-in sequence

1. **F1** — add boundary characterization + grep-guards (gate).
2. **F3** — delete dead `task-render.ts` exports (pure removal, zero callers).
3. **F4 / F5 / F6** — extract the duplicated small helpers (`normalizeActorId`, `asRecord`/
   `stringField`, delivery-ref parser). Independent, low-risk, internal-only.
4. **F7** — unify the HTTP request core downward (typed client → shared primitive).
5. **F2** — M02 contract narrowing of `AcpClient` (`promoteTask`, `listTransitions` first; `createTask`
   only after confirming no external import). Public-surface — do last, behind F1's guard.

## Safety checklist

- [ ] `bun test` green before and after each step (per-step, not batched).
- [ ] `tsc --noEmit` clean (this package type-checks via `tsc`).
- [ ] `grep` guards from F1 confirm no remaining references to removed members.
- [ ] No change to `src/index.ts` export list except the F2 interface narrowing (and only after
      confirming sibling packages don't import the removed `AcpClient` methods / `createTask`).
- [ ] Preserve exact field sets in F6 (`{scopeRef?, laneRef?}`) and F7 (header rules, error classes).
- [ ] Do NOT touch F8/F9/F10 (deliberate seams).
- [ ] After apply, revert any incidental `bun.lock` / `package.json` dev-dep churn before reporting
      (per repo memory note on parallel apply-agent churn).
