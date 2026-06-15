# Refactor Analysis: `packages/acp-e2e`

## Summary

`acp-e2e` is a **leaf integration-test package** (`private: true`, `version 0.0.1`). It has
**no `src/`, no `index.ts`, and no exported public API** — its only artifacts are three
`bun test` suites plus two test fixtures under `test/fixtures/`. Nothing in the monorepo
imports from it; its dependents are the test runner and CI. Therefore the **Expand/Contract
discipline (M02) does not apply** (no consumers to migrate), and the package-type profile is
**leaf**: drop M02, treat the "public surface" as the fixture functions that the suites import,
and weigh changes purely by their effect on the three test files.

The package is in good shape overall. There is exactly **one high-leverage finding**: the two
JobFlow suites (`jobflow-mvp.test.ts`, `jobflow-exec.test.ts`) carry ~180 lines of *verbatim*
duplicated fixture scaffolding (HRC sqlite harness, recording stores, terminal-flow launcher,
job CRUD helpers, payload types). Everything else is small, localized polish or deliberately
left alone. Files read in full: 8 (package.json, README.md, tsconfig.json, the 2 fixtures, the
3 test suites).

## Public boundary — assessed first

**Verdict: sound (for a leaf).**

The package has no exported module boundary. The de-facto "interface" is what the test suites
import from `test/fixtures/`:

- `seed-stack.ts` exports `SeedStack`, `createSeedStack`, `withSeedStack` (and the implicit
  `SeedStackOptions`). `withSeedStack` is a clean resource-scoping wrapper (acquire → run →
  always cleanup) and is used by all three suites. `SeedStackOptions` is a thin pass-through
  onto `AcpServerDeps` keys — appropriate for a test harness that needs to inject fakes.
- `mock-launcher.ts` exports `RecordedLaunch`, `RecordingMockLauncher`,
  `createRecordingMockLauncher`. Used only by `e2e-interface.test.ts`. Cohesive, single
  responsibility (record launches, replay an assistant `message_end`).

The fixture surface is **narrow and matched to actual usage** — no leaky over-exposure, no fat
exports. The one defect is *not* the fixture surface but the **fixture scaffolding that was
inlined into the two jobflow suites instead of living in `test/fixtures/`** (see Finding 1).
That is a cohesion/affinity defect, not a boundary-shape defect.

## Findings by mechanism (outside-in)

### Finding 1 — Extract the duplicated JobFlow fixture into `test/fixtures/` (highest leverage)

- **Location:** `test/jobflow-mvp.test.ts:1-186` and `test/jobflow-exec.test.ts:1-186`
  (the two regions are byte-identical except for 5 cosmetic strings).
- **Technique:** [T15] extract missing abstraction + [T03] relocate by affinity/cohesion.
- **Mechanism repaired:** duplicated *intent* with no single home. The HRC-db harness
  (`HeadlessHrcFixture`, `createHeadlessHrcDb`, `insertTerminalHrcRun`,
  `createTerminalFlowLauncher`), the recording store (`RecordingInputAttemptStore`), the job
  lifecycle helpers (`createFlowJob`, `runJob`, `getJobRun`), and the shared types
  (`JobRunPayload`, `LaunchCall`, `FlowLaunchOutcome`) are fixture machinery, not assertions —
  they belong beside `seed-stack.ts`/`mock-launcher.ts`, imported by both suites.
- **Verified delta (the only differences across the 180 lines, confirmed via `diff`):**
  - temp-dir prefix `acp-e2e-jobflow-` vs `acp-e2e-jobflow-exec-`
  - `hostSessionId`/`sessionId` label `session-jobflow-e2e` vs `session-jobflow-exec-e2e`
  - `scopeRef` task `T-01314` vs `T-01321`
  - `input.content` string
  These become parameters (e.g. `createHeadlessHrcDb(prefix?)`,
  `createTerminalFlowLauncher(hrc, outcomes, calls, { sessionId })`,
  `createFlowJob(stack, flow, { scopeRef?, content? })`) with the current values as defaults so
  both suites keep their exact behavior.
- **Direction:** remove (collapse duplication) + relocate into a new
  `test/fixtures/jobflow-stack.ts`.
- **Preservation rung:** behavior-preserving refactor — same SQL, same fake launcher logic,
  same request bodies, same assertions. Highest rung: the test bodies (the `describe`/`test`
  blocks and every `expect`) are untouched; only the shared scaffolding moves and is
  parameterized.
- **Falsifiable signal:** `bun test` in the package passes with the identical set of passing
  tests; `git diff --stat` shows ~180 deleted lines from each suite and a new fixture file;
  no assertion text changes.
- **Risk:** Low. **API-impact:** internal-only (fixtures are not exported from the package).
- **Effort:** M (one new fixture file ~140 lines; two suites lose their preambles and gain a
  small import + a couple of call-site args).
- **Tests:** existing `bun test` is the safety net (this *is* the test package). No new tests
  needed; the refactor must not change which tests exist or pass.
- **Contraindication:** none material. The only caution is the parameterization must preserve
  the *exact* field set on each fake outcome and request body (don't silently normalize the
  `T-01314`/`T-01321` scopeRefs or the session-id labels — keep them as caller-supplied values
  so the two suites stay distinguishable in temp-dir names and logs).

### Finding 2 — `JobRunPayload.steps[].result` typed as `Record<string, unknown>`

- **Location:** `test/jobflow-exec.test.ts:36-37` (`result?: Record<string, unknown>`),
  asserted at `:286-295`, `:299-306`, `:368-376`.
- **Technique:** [T15] extract missing abstraction (light) — optional.
- **Mechanism:** the exec-result shape (`kind`, `argv`, `cwd`, `exitCode`, `stdout`, `stderr`,
  `timedOut`) is a real, repeated value object expressed only as an untyped bag. A named type
  would document the contract the suite is pinning. This is borderline; the assertions are
  `objectContaining`, so the loose type is intentional latitude.
- **Direction:** add (optional) — extract an `ExecStepResult`-shaped type if Finding 1's
  fixture file is created (natural home).
- **Preservation rung:** behavior-preserving (type-only).
- **Falsifiable signal:** `tsc --noEmit` still passes; no runtime change.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** keep `objectContaining` semantics — do not tighten the assertion into
  `toEqual`, which would change behavior by failing on the exec result's extra fields. Type is
  documentation only.

### Finding 3 — `process.stdout/stderr/exit` monkey-patch block in `runCli`

- **Location:** `test/fixtures/seed-stack.ts:89-154`.
- **Technique:** [T22] guard clauses / isolate — assessed and **left as-is**.
- **Mechanism:** the function swaps three globals + env, runs the CLI, and restores everything
  in `finally`. It is genuinely doing process-global interception; the `try/finally` already
  guarantees restoration on both the `CliExit` path and the rethrow path. The nesting is not
  excessive (single try/catch/finally) and the restoration loop correctly distinguishes
  "delete vs reset". No swallowed errors (`T18` clean): non-`CliExit` errors are rethrown.
- **Direction:** none.
- **Risk:** n/a. Listed here to record that it was pressure-tested and is sound.

## Deliberately left alone (where-NOT)

- **`SeedStackOptions` spread-merge into `serverDeps`** (`seed-stack.ts:189-204`): the
  `...(opt !== undefined ? { key: opt } : {})` pattern is verbose but deliberate — it preserves
  `exactOptionalPropertyTypes` semantics (omit vs `undefined`) when forwarding to
  `AcpServerDeps`. Collapsing it to a plain spread would change which keys are present and could
  alter `createAcpServer` defaulting. Load-bearing; leave it.
- **`mock-launcher.ts` `last()` / non-null assertions in suites** (`e2e-interface.test.ts`,
  e.g. `launch?.runId as string`): test-local sharpness against fixtures guaranteed to exist by
  the preceding `expect(...).toBeDefined()`. Not worth `T17` totalization in a test.
- **Duplicated `createHeadlessHrcDb` SQL schema across the two jobflow files**: folded into
  Finding 1 (same extraction); not a separate item.
- **`createInProcessFetch` / `CliAdapter`** (`seed-stack.ts:79-87, 208-228`): cohesive, single
  in-process transport seam. Correct level of abstraction for an e2e harness; no premature
  generality to collapse (`T16` does not apply).
- **No `T19` dispatch refactor**: there is no growing type/enum switch; the flow-step variation
  (agent vs exec) lives in `acp-server`, not here.

## If applying: outside-in sequence

1. Establish the green baseline: `bun test` in `packages/acp-e2e` (record the passing set).
2. **Finding 1** — create `test/fixtures/jobflow-stack.ts` housing the shared HRC harness,
   recording store, terminal-flow launcher, job CRUD helpers, and shared types; parameterize
   the 5 cosmetic differences with defaults. Update both jobflow suites to import them and pass
   their distinguishing values. Run `bun test` + `tsc --noEmit`.
3. **Finding 2** (optional) — give the exec-result a named type in the new fixture file; keep
   `objectContaining` assertions unchanged. Run `tsc --noEmit`.
4. Final gate: full `bun test` + `tsc --noEmit`; confirm identical passing test set and no
   churn in `dist/` source (only emitted `.d.ts` for the new fixture).

## Safety checklist

- [ ] `bun test` passes with the same number of tests, same names, all green (before & after).
- [ ] `tsc --noEmit` clean.
- [ ] No assertion text or expected-value changed (only scaffolding moved/parameterized).
- [ ] Exact field sets preserved on fake outcomes and request bodies; the two suites remain
      distinguishable (temp-dir prefix, session-id label, scopeRef task).
- [ ] `expect.objectContaining` semantics preserved (no tightening to `toEqual`).
- [ ] No source file outside `test/` touched; package stays `private`/leaf (no new exports from
      a package index — there is none).
- [ ] `git diff` shows net line reduction concentrated in the two jobflow suites.
