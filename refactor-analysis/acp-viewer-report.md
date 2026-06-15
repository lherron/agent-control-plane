# Refactor Analysis — `packages/acp-viewer`

Package type: **leaf / general (front-end SPA)**. `package.json` is `private: true` with no
`exports`/`main`; nothing in the workspace imports it. The "public boundary" is therefore the
*internal* seams that the app is built against: the route table (`src/routes.tsx` + per-feature
`routes.tsx`), the HTTP/WS data layer (`src/lib/api.ts`, `features/*/data.ts`,
`features/sessions/api/mobile-socket.ts`), the shared design primitives
(`src/components/primitives.tsx`), and the shared response contracts (`src/types/api.ts`).
Because there are no external consumers, **M02 Expand/Contract is dropped** — internal renames
can be applied directly (one atomic commit) as long as the route table and the WS wire-shapes
are preserved.

## Summary

The package splits cleanly into two halves with very different health:

- **Sessions feature (live HRC dashboard)** — `features/sessions/**`. Well-architected, well
  documented, has unit tests (`mobile-adapter.test.ts`), and a clean layering
  (wire frames -> adapter -> ported reducer store -> hook -> presentational components). The
  one stable seam (`features/sessions/types.ts`) re-exports the projection contracts. **Leave
  almost entirely alone.**
- **CRUD-display features (projects / agents / jobs / scheduler)** — these carry essentially
  all the rot: duplicated fetch infrastructure, duplicated date/actor formatters, ~5 copies of a
  status->tone mapper, dead files (TODO stubs, an unused `AgentCard`, an unused `agent-motif`,
  an unused `.d.ts` global), a **triple-layer scheduler** (`routes -> scheduler-page ->
  pages/scheduler-state`, plus a fourth orphaned `components/scheduler-state.tsx`), and a
  bypassed `lib/api.ts` whose `listProjects`/`listAgents`/`getSchedulerState`/`getAgentHeartbeat`
  are never called.

Highest-leverage, lowest-risk wins: delete dead code (T16), collapse the duplicated
`fetchJson`/`BASE_URL` and formatter helpers into one home (T15/T03), and collapse the scheduler
pass-throughs (T23). The duplicated status->tone mapper (T15) is the single most-repeated smell.

The package has **no make-safe gap for the risky areas**: the sessions adapter/reducer is
covered, and the CRUD features have import-smoke tests. Pure-helper extractions below are
mechanically safe; UI consolidation (TabBar) is the only item that touches rendered markup and
is flagged Med.

## Public boundary — verdict: **needs-care**

Three boundary defects, none externally observable but all corrosive internally:

1. **Bypassed / dead data layer (`src/lib/api.ts`).** [T07 align interface to actual usage]
   `getProjectDetail`, `getAgentDetail`, `getAgentSystemPrompt`, `getJobDetail`, `listJobs` are
   used; `listProjects`, `listAgents`, `getSchedulerState`, `getAgentHeartbeat` are **never
   imported anywhere** (verified by grep). Meanwhile `features/projects/data.ts` and
   `features/agents/data.ts` *re-implement* `BASE_URL` + `fetchJson` and hit
   `/v1/admin/projects` / `/v1/admin/agents` / `.../heartbeat` directly — duplicating the exact
   logic the unused `lib/api.ts` functions already provide. The interface and its callers have
   drifted apart. Direction: remove the dead exports; widen `lib/api.ts` to be the single fetch
   seam OR narrow it to only what is used.

2. **Type laundering at the data seam.** `features/projects/data.ts:25` and
   `features/agents/data.ts:17` do `return getX(id) as unknown as YState`, casting the
   `*Response` contract (`src/types/api.ts`) to a *different* hand-rolled `*State` contract
   (`features/*/types.ts`). The double-cast disables all type checking between the API contract
   and what every tab component consumes. This is a real divergence (e.g. `ProjectDetailResponse`
   has `systemEvents`/`jobs:JobSummary[]`; `ProjectDetailState` has
   `recentSystemEvents`/`jobs:ProjectJobSummary[]`). Behavior-preserving repair is bounded;
   reconciling the two type families is a redesign (flagged High / public-surface below).

3. **Duplicated `ProvenanceItem` contract** in three places
   (`components/provenance-strip.tsx:6`, `features/projects/types.ts:3`,
   `features/agents/types.ts:3`) with *different shapes* (`{label,source,timestamp}` vs
   `{source,available}`). The strip component already prefers `provenance: ProvenanceEntry[]`
   from `types/api.ts`; the feature `ProvenanceItem`s are vestigial.

Everything else in the boundary (route tables, `mobile-socket` handler contract,
`primitives.tsx` prop shapes, `types/api.ts` job/flow contracts) is sound.

## Findings by mechanism (outside-in)

### Boundary

#### F1 — Dead exports in the data seam · `src/lib/api.ts:29,41,80,86`
- **Technique:** T07 align interface to actual usage (narrow).
- **Mechanism repaired:** an export surface that lies about its usage — four functions
  (`listProjects`, `listAgents`, `getSchedulerState`, `getAgentHeartbeat`) advertise a contract
  no caller consumes, while the real callers duplicate the same fetch logic elsewhere.
- **Direction:** remove (or, if F2 consolidates onto `lib/api.ts`, re-point callers and keep).
- **Preservation rung:** unused symbol removal — no runtime path touches them.
- **Falsifiable signal:** `grep -rn '\blistProjects\b|\blistAgents\b|\bgetSchedulerState\b|\bgetAgentHeartbeat\b' src` returns only `lib/api.ts` (confirmed). After removal, `tsc --noEmit` + `bun test` stay green.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Tests:** existing import-smoke tests; typecheck.
- **Contraindication:** if F2 elects to make `lib/api.ts` the single fetch home, *keep*
  `getAgentHeartbeat`/`listProjects`/`listAgents` and re-point `data.ts` to them instead of deleting.

#### F2 — Duplicated `BASE_URL` + `fetchJson` across the data layer · `src/lib/api.ts:15-25`, `src/features/projects/data.ts:5-15`, `src/features/agents/data.ts:5-14`, `src/features/scheduler/pages/scheduler-state.tsx:14-21`, `src/components/scheduler-state.tsx:12-21`
- **Technique:** T15 extract missing abstraction (+ T03 relocate by affinity).
- **Mechanism repaired:** the "how do I reach the admin API" decision is re-expressed five times,
  three of them character-identical (`fetchJson`), with subtly different `import.meta.env`
  access (`lib/api.ts` uses `import.meta.env.VITE_...`; the others use the
  `(import.meta as ...).env` cast). One concept, five sites.
- **Direction:** relocate into one module (extend `lib/api.ts`’s `fetchJson`/`BASE_URL`); have
  `data.ts` and the scheduler page import it.
- **Preservation rung:** identical observable fetch behavior — same URL, same error string
  (`API ${status}: ${path}`), same JSON cast. Pick the `import.meta.env` form `lib/api.ts`
  already uses (the canonical Vite form) so DEV/prod base-URL resolution is unchanged.
- **Falsifiable signal:** after consolidation, network calls in the running app are byte-identical
  (same paths) and `bun test` green. A unit assert on `fetchJson` error message guards the string.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** M.
- **Contraindication:** the `import.meta.env` access form differs between files for a reason
  (some were ported under a non-Vite test harness). Verify the chosen form resolves under
  `bun test` AND `vite build` before deleting the casted variants.
- **Churn:** touches 5 files; deletes ~40 lines of duplication.

#### F3 — Three divergent `ProvenanceItem` contracts · `src/components/provenance-strip.tsx:6`, `src/features/projects/types.ts:3`, `src/features/agents/types.ts:3`
- **Technique:** T16 collapse premature abstraction / T07 align to usage.
- **Mechanism repaired:** a shared name with three incompatible shapes; the consuming component
  already standardizes on `ProvenanceEntry` from `types/api.ts`, so the feature-local
  `{source,available}` variants are dead weight that *look* shared.
- **Direction:** remove the feature-local `ProvenanceItem`s (verify they’re only referenced by
  the `*State.provenance` field, which is itself part of the laundered `*State` types in F-High-1).
- **Preservation rung:** type-only change; `provenance-strip` already keys off `ProvenanceEntry`.
- **Falsifiable signal:** `tsc --noEmit` green after deletion; `provenance-strip.test.ts` passes.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** entangled with the `*State` types (F-High-1); if those are left as-is,
  the field type must stay assignable — keep the field, drop the duplicate interface only if the
  shapes already match `ProvenanceEntry`.

### Seams & structure

#### F4 — Dead modules (premature/abandoned structure) · `src/features/projects/projects-page.tsx`, `src/features/agents/agents-page.tsx`, `src/features/agents/components/agent-card.tsx`, `src/features/agents/components/agent-motif.ts`, `src/features/projects/api-compat.d.ts`, `src/components/scheduler-state.tsx`
- **Technique:** T16 de-abstract / remove structure whose variation never materialized.
- **Mechanism repaired:** modules that exist but are never imported (verified by grep):
  - `projects-page.tsx` / `agents-page.tsx` — `TODO:` placeholder components, zero importers.
  - `agent-card.tsx` (`AgentCard`) — superseded by `AgentEntry`/`AgentEntryStub`; zero importers
    (also carries a 4th copy of `heartbeatTone`, see F5).
  - `agent-motif.ts` (`motifBackground`) — defined, never imported.
  - `api-compat.d.ts` — declares a `global { interface JobSummary }` shim; zero importers,
    and a global ambient `JobSummary` is a foot-gun that can silently satisfy unrelated code.
  - `components/scheduler-state.tsx` (`SchedulerStatePanel`) — orphaned earlier scheduler
    implementation; the live page is `features/scheduler/pages/scheduler-state.tsx`.
- **Direction:** remove.
- **Preservation rung:** unreferenced module removal — no route, no import path reaches them.
- **Falsifiable signal:** `tsc --noEmit` + `vite build` + `bun test` all green after deletion;
  app routes unchanged.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** `agent-card.tsx` is a polished component someone may intend to swap back
  in; confirm with the owner if the catalogue design is still in flux. The deletion itself is safe.

#### F5 — ~5 copies of status->tone mapper · `src/features/agents/components/agent-card.tsx:21`, `src/features/agents/components/agent-entry.tsx:21`, `src/features/agents/pages/agent-detail.tsx:41`, `src/features/jobs/components/job-runs-tab.tsx:22`, `src/components/job-flow-canvas/step-inspector.tsx:30`
- **Technique:** T15 extract missing abstraction.
- **Mechanism repaired:** the same partial function status:string -> PillTone is written five
  times. Two flavors exist: a *heartbeat* tone (`alive/stale/dead`) and a *run-status* tone
  (`succeeded/failed/skipped`); both return the identical `'success'|'destructive'|'warn'|'muted'`
  union. The intent ("map a status string to a Pill tone") is duplicated, not the incidental cases.
- **Direction:** extract two named helpers (e.g. `heartbeatTone`, `runStatusTone`) into a shared
  module co-located with `primitives.tsx` (the `PillTone`/tone union lives there).
- **Preservation rung:** each call site keeps its exact mapping (heartbeat vs run-status differ
  on which strings map where) — do **not** merge the two into one function; that would change
  output for some inputs. Preserve the case sets verbatim.
- **Falsifiable signal:** table-test each helper against the union of all five current branch
  sets; outputs identical pre/post.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** M.
- **Contraindication:** the heartbeat mapper and the run-status mapper are NOT the same function
  (heartbeat keys on `alive/stale/dead/down`, runs key on `succeeded/failed/skipped`). Keeping
  them as two helpers is the correct grain — over-merging trips behavior preservation.

#### F6 — Duplicated date/actor formatters · `src/features/projects/project-utils.ts:3-32`, `src/features/agents/agent-utils.ts:3-32`, plus local `fmtDate`/`timeAbs` in `src/features/jobs/components/job-runs-tab.tsx:9`, `job-schedule-tab.tsx:8`, `job-overview-tab.tsx:9`, `jobs-catalog.tsx:49`
- **Technique:** T15 extract missing abstraction / T03 relocate by affinity.
- **Mechanism repaired:** `formatActor` and `formatDateTime` are **byte-identical** between
  `project-utils.ts` and `agent-utils.ts`. Separately, four jobs files hand-roll
  `new Intl.DateTimeFormat(...)` date helpers with two slightly different option sets
  (`dateStyle/timeStyle` vs `month/day/hour/minute`). One formatting concept, scattered.
- **Direction:** extract `formatActor`/`formatDateTime` into one shared `lib/format.ts`; relocate
  there. Keep the two *distinct* date presentations as two named exports (e.g.
  `formatDateTime` long-form and `formatTimestamp` compact) — they are deliberately different.
- **Preservation rung:** identical output strings, including the `'None'` / `'—'` / raw-passthrough
  fallbacks (note: the two existing fallbacks differ — `formatDateTime` returns `'None'`,
  the jobs `fmtDate` returns `'—'`; preserve per-call-site by keeping both helpers).
- **Falsifiable signal:** snapshot the rendered date/actor cells for a fixture job/agent/project
  before and after; identical.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** M.
- **Contraindication:** the `'None'` vs `'—'` empty-renderings are user-visible and intentional
  per surface; do NOT unify the fallback string. The jobs compact format and the projects/agents
  long format are also intentionally different — keep two functions.

#### F7 — `getJob*` accessor helpers duplicated across projects/agents · `src/features/projects/project-utils.ts:38-63`, `src/features/agents/agent-utils.ts:42-63`
- **Technique:** T15 extract missing abstraction (with care).
- **Mechanism repaired:** `getJobId`/`getJobKind`/`getJobCron`/`getJobNextFireAt`/
  `getJobFlowStepCount` exist in both util files over near-identical `*JobSummary` shapes, but
  the shapes differ slightly (projects’ `CompactJobRecord` has `laneRef/lastFireAt/cron`; agents’
  has fewer fields; `getJobCron` fallback chains differ: projects also fall back to `job.cron`).
- **Direction:** extract a shared accessor module **only after** the projects/agents
  `*JobSummary` types are reconciled — otherwise the parameterized type widens silently.
- **Preservation rung:** each accessor’s fallback chain must be preserved exactly
  (`getJobCron` projects: `summary.cron ?? schedule.cron ?? job.cron ?? 'Manual'`; agents:
  `summary.cron ?? schedule.cron ?? 'Manual'` — note the missing `job.cron` arm).
- **Falsifiable signal:** fixture-test each accessor’s fallback ladder; identical outputs.
- **Risk:** Med (shape divergence). **API-impact:** internal-only. **Effort:** M.
- **Contraindication:** load-bearing difference in `getJobCron` fallback — naive dedup changes
  the projects-side cron resolution. Defer to F-High-1 (type reconciliation) or keep separate.

### Quality / middle-man

#### F8 — Triple-layer scheduler pass-through · `src/features/scheduler/routes.tsx` -> `src/features/scheduler/scheduler-page.tsx:3` -> `src/features/scheduler/pages/scheduler-state.tsx`
- **Technique:** T23 remove middle man / collapse pass-throughs.
- **Mechanism repaired:** `scheduler-page.tsx` is a one-line wrapper
  (`return <SchedulerStatePage />`) that adds nothing; the route could reference the page
  directly. (`components/scheduler-state.tsx` is a *fourth* orphaned copy — covered by F4.)
- **Direction:** collapse — point `schedulerRoutes` at `pages/scheduler-state.tsx` (export it as
  `SchedulerPage` or update the import) and delete `scheduler-page.tsx`.
- **Preservation rung:** route renders the same component tree; URL `/scheduler` unchanged.
- **Falsifiable signal:** `scheduler-feature.test.ts` (imports `schedulerRoutes`) stays green;
  app navigates to `/scheduler` and renders the same page.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** `scheduler-feature.test.ts` imports `./scheduler-page` or `./routes` —
  check the exact symbol the test asserts before renaming the export.

#### F9 — Data-layer wrappers that only re-cast · `src/features/projects/data.ts:24-26`, `src/features/agents/data.ts:16-18,32-37`
- **Technique:** T23 remove middle man.
- **Mechanism repaired:** `fetchProjectDetail`/`fetchAgentDetail` are pure pass-throughs to
  `getProjectDetail`/`getAgentDetail` whose only "work" is an `as unknown as` cast (the cast
  itself is the F-High-1 problem). `fetchAgentSystemPrompt` is a literal pass-through to
  `getAgentSystemPrompt` with the identical signature.
- **Direction:** once F-High-1 reconciles the types, these wrappers vanish — call `lib/api.ts`
  directly from the pages. Until then, `fetchAgentSystemPrompt` (no cast) can already collapse.
- **Preservation rung:** identical call results; only an indirection removed.
- **Falsifiable signal:** typecheck green; agent system-prompt tab fetches unchanged.
- **Risk:** Low (for `fetchAgentSystemPrompt`) / Med (the casting wrappers, coupled to F-High-1).
- **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** do not remove the *casting* wrappers without resolving F-High-1 — the
  cast is currently hiding a real type mismatch; deleting it surfaces compile errors that are a
  redesign, not a refactor.

### Higher-risk / public-surface (NOT auto-applicable)

#### F-High-1 — Two parallel response-type families reconciled by `as unknown as` · `src/types/api.ts` (`ProjectDetailResponse`, `AgentDetailResponse`) vs `src/features/projects/types.ts` (`ProjectDetailState`), `src/features/agents/types.ts` (`AgentDetailState`); casts at `features/projects/data.ts:25`, `features/agents/data.ts:17`
- **Technique:** T12 make illegal states unrepresentable / T07 align interface to actual usage.
- **Mechanism:** the data seam claims an API returns shape A (`*Response`) but every UI consumer
  reads shape B (`*State`); the `as unknown as` bridge means the compiler verifies *neither*.
  Field names genuinely differ (`systemEvents` vs `recentSystemEvents`, `jobs:JobSummary[]` vs
  `jobs:ProjectJobSummary[]`, `memberships:MembershipSummary[]` vs `ProjectMembership[]`). At
  runtime the server payload is presumably shape B, so the `*Response` types in `types/api.ts`
  may be *wrong* for these two endpoints. Determining the true wire shape requires checking the
  acp-server admin handlers — this changes a contract and can alter behavior if the types are
  fixed incorrectly. **Redesign, not refactor.** Defer with a human + server-handler cross-check.
- **Risk:** High. **API-impact:** public-surface (the admin API contract). **Effort:** L.

#### F-High-2 — Three near-duplicate tab-bar implementations · `src/components/primitives.tsx:95` (`TabBar`), `src/features/agents/pages/agent-detail.tsx:301` (`AgentDossierTabs`), `src/components/job-flow-canvas/step-inspector.tsx:52-82` (inline)
- **Technique:** T15 extract missing abstraction / T16 collapse to the existing primitive.
- **Mechanism:** the editorial underline-tab pattern (role=tablist, active underline, hover
  color) is implemented three times. `AgentDossierTabs` adds a per-agent `--agent-color` accent;
  the `StepInspector` tabs are an inline simplified variant. Consolidating onto `TabBar` is
  desirable but touches *rendered markup/styling* and ARIA on a user-facing surface, so it is a
  behavior-affecting visual change, not a pure refactor.
- **Direction:** widen `primitives.TabBar` to accept an optional accent color, then replace the
  two variants. Requires visual QA (the dossier tabs use a colored underline + backdrop-blur the
  base `TabBar` lacks).
- **Risk:** Med->High (visual regression surface). **API-impact:** public-surface (UI). **Effort:** M.
  Flagged here (not auto-applied) because it alters rendered output.

## Deliberately left alone (where-NOT)

- **`features/sessions/**` (adapter, reducer store, mobile-socket, hook, components).** Clean
  layering, documented invariants, dedicated unit tests. The reducer store is a deliberate
  verbatim port ("Ported verbatim from acp-ops-web") — re-shaping it would diverge from its
  source of truth for no behavioral gain. The `mobile-socket` `try/catch {}` blocks around
  `JSON.parse`/`socket.close()` are intentional (malformed frames are dropped, close is
  best-effort) — NOT swallowed errors to "fix" (contraindication for T18).
- **`components/job-flow-canvas/layout.ts`** — pure, tested (`job-flow-canvas.test.ts`),
  single-responsibility. The geometry magic numbers in `index.tsx` (`LABEL_CHAR_WIDTH`, etc.)
  are already named constants — no T15 needed.
- **`mobile-frames.ts` local wire types** — deliberately local because acp-server does not export
  them (documented). Not a missing-abstraction; a correct boundary copy.
- **`empty-snapshot.ts`** — small, single-purpose seed; the literal counts are the contract.
- **`primitives.tsx` `PILL_TONE` / `StatusDot` tone maps** — these are the canonical tone
  definitions; the F5 duplication is in the *callers*, not here.
- **`SectionHeader` `index?` prop (primitives.tsx:165)** — marked "Deprecated, kept for prop
  compat." With no external consumers this *could* be dropped (T16), but it’s a 1-line no-op and
  removing it is churn with near-zero payoff; left as a judgment call for the owner.

## If applying — outside-in sequence

1. **F4 — delete dead modules** (`projects-page`, `agents-page`, `agent-card`, `agent-motif`,
   `api-compat.d.ts`, `components/scheduler-state.tsx`). Smallest blast radius; shrinks the
   surface everything else reasons about. Verify `tsc`/`build`/`test` green.
2. **F1 — remove dead `lib/api.ts` exports** (or decide to keep + re-point in step 4).
3. **F8 — collapse scheduler pass-through** (`scheduler-page.tsx`).
4. **F2 — unify `fetchJson`/`BASE_URL`** onto `lib/api.ts`; re-point `data.ts` + scheduler page.
5. **F6 — extract `formatActor`/`formatDateTime`** to `lib/format.ts` (keep two date helpers).
6. **F5 — extract `heartbeatTone` / `runStatusTone`** (two helpers, not one).
7. **F3 — drop duplicate `ProvenanceItem`** (only if shapes already align; else fold into F-High-1).
8. **F9 — collapse `fetchAgentSystemPrompt` pass-through** (the no-cast one only).
9. **Defer:** F7 (coupled to type reconciliation), F-High-1 (redesign + server cross-check),
   F-High-2 (visual consolidation with QA).

Re-run `bun test`, `tsc --noEmit`, and `vite build` after each of steps 1–8 (they’re independent;
keep them as separate commits so any visual regression is bisectable).

## Safety checklist

- [ ] `bun test` green (sessions adapter, routes import-smoke, layout, provenance, agent-profile).
- [ ] `tsc --noEmit` green — especially after F2 (env access) and F3 (provenance types).
- [ ] `vite build` succeeds (catches the `import.meta.env` form chosen in F2 under prod build).
- [ ] Grep confirms every "dead" symbol (F1/F4) has zero importers before deletion (re-run, do
      not trust this report — code may have changed).
- [ ] No fallback-string changes leak (F6: `'None'` vs `'—'`; F5/F7: cron/tone fallback ladders).
- [ ] Do NOT touch `features/sessions/**` or `job-flow-canvas/layout.ts`.
- [ ] Do NOT remove the casting data-layer wrappers (F9 casting path) without F-High-1.
- [ ] Per-step commits so a visual/behavioral regression bisects to one mechanism.
- [ ] Watch for `bun.lock` / `package.json` dev-dep timestamp churn from any `bun install` and
      revert churn-only changes before reporting (per MEMORY: parallel-apply bun churn).
