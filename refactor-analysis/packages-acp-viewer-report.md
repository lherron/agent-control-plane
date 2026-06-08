# Refactor Analysis — `packages/acp-viewer`

Methodology: SOLID + code-smell audit (ANALYSIS ONLY — no source mutated).
Scope analyzed: `packages/acp-viewer/src` — 25 `*.ts` files (2,366 lines, of which 229 are tests) plus the React `*.tsx` layer (5,830 lines). Total non-test source surface ≈ **7,967 lines**. The package is a Vite/React SPA (the "ACP viewer"); the bulk of logic lives in `.tsx`, so this audit covers both, with emphasis on the central `.ts` modules requested.

---

## Scorecard

| Dimension | Grade | Notes |
|---|---|---|
| SRP (Single Responsibility) | B− | Most files are tight. `use-reducer-store.ts` mixes store wiring + reducer + selectors + summary derivation. `agent-detail.tsx` (371 LOC) bundles page orchestration + 6 presentational sub-components. |
| OCP (Open/Closed) | B | A few `switch`/if-chains keyed on string unions (`deriveRowStatus`, `motifBackground`, `inferKind`, `describeCron`). Most are table-driven already (good: `EDGE_COLORS`, `FAMILY_*` maps). |
| LSP (Liskov) | A | No class hierarchies / overrides. N/A in practice. |
| ISP (Interface Segregation) | B | No fat interfaces >10 members on the consumer side, but `JobDetailResponse.lineage` is a 7-field bag of `Record<string, unknown>`. |
| DIP (Dependency Inversion) | B− | `fetch` + `BASE_URL` + `import.meta.env` hardcoded and **copy-pasted into 5 modules**; `new WebSocket()` hardcoded in `mobile-socket.ts` (acceptable for a transport module). |
| DRY / Duplication | **C** | Largest debt. `fetchJson`/`BASE_URL` duplicated 5×; `formatActor`/`formatDateTime` duplicated verbatim across two `*-utils.ts`; `ProvenanceItem`/`CompactJobRecord`/`CompactJobSummary` duplicated across two `types.ts`; `SchedulerStateResponse` defined 3× with two different shapes; iso-date formatter re-implemented ~6×. |
| Dead code | B | One fully unused component module (`components/scheduler-state.tsx`). |
| Magic numbers / primitives | B | Mostly named constants. Some literal pixel/opacity/priority numbers and bare status strings. |

Overall: **B−**. Behavior is sound and modules are individually readable; the dominant issue is cross-module duplication (fetch layer, formatters, shared DTO types) and a couple of oversized files.

---

## Priority Refactorings

### P1 — Consolidate the duplicated fetch layer (`fetchJson` + `BASE_URL`)
The exact `BASE_URL` resolution + `fetchJson<T>` (throw on `!res.ok`) block is independently re-declared in:
- `lib/api.ts:15` / `lib/api.ts:19`
- `features/agents/data.ts:6` / `:8`
- `features/projects/data.ts:6` / `:9`
- `features/scheduler/pages/scheduler-state.tsx:14` / `:17` (inline `fetchSchedulerState`)
- `components/scheduler-state.tsx:12` / `:15` (inline, in dead module)

Impact: high (every new endpoint risks a 6th copy; error-handling/auth changes must be made in 5 places). Effort: medium. Risk: low-medium — `lib/api.ts` uses `import.meta.env` directly while the `data.ts` copies use a defensively-typed `(import.meta as …).env` accessor; unifying must preserve the more defensive form. **Not behavior-preserving** (changes import wiring / the env-access expression).

### P2 — De-duplicate `formatActor` / `formatDateTime`
`features/agents/agent-utils.ts:3-32` and `features/projects/project-utils.ts:3-32` contain byte-identical `formatActor` and `formatDateTime`. Extract to one shared util (e.g. `lib/format.ts`) and re-export. Impact: medium. Effort: low. Risk: low. The *extraction itself* is behavior-preserving, but **rewiring two feature modules to import from a new path is not purely local** — flagged `behaviorPreserving:false` to be safe for the apply stage.

### P3 — Unify duplicated shared DTO types
`ProvenanceItem` (identical), `CompactJobRecord`, and `CompactJobSummary` are declared separately in `features/agents/types.ts:3,27,38` and `features/projects/types.ts:3,17,32` (the Compact* variants have drifted: project's has extra `lastFireAt`/`createdAt`/`updatedAt`/`onFailureStepCount`). Promote the common shape to a shared types module; let each feature extend it. Impact: medium (type drift is already happening). Effort: medium. Risk: medium — merging drifted shapes can change which fields are required/optional. **Not behavior-preserving.**

### P4 — Resolve the triple `SchedulerStateResponse` definition + dead component
`SchedulerStateResponse` is defined in `types/api.ts:326` (rich: `upcomingFires`, `stats`) and re-declared with a **different** shape (`dueCount`, `claimedCount`, `errors`, `note`) in both `features/scheduler/pages/scheduler-state.tsx:5` and `components/scheduler-state.tsx:3`. The `components/scheduler-state.tsx` module (`SchedulerStatePanel`, 89 LOC) is **never imported** — routing uses `features/scheduler/pages/scheduler-state.tsx` (`SchedulerStatePage`) only. Delete the dead module; reconcile the type. Impact: medium (confusing source of truth). Effort: low. Risk: low for the deletion. Deleting provably-dead, unreferenced code is **behavior-preserving**; reconciling the type shapes is not.

### P5 — Split `use-reducer-store.ts` (237 LOC, mixed concerns)
`features/sessions/store/use-reducer-store.ts` co-locates: zustand store creation (`dashboardStore`), the reducer (`reduceDashboardAction`, ~88 LOC switch), snapshot/summary derivation (`summarize`, `rowsForState`, `eventsForState`, `createReducerState`), and the public hook/dispatch API. The reducer + selectors are pure and independently testable; extracting them into a sibling module would shrink the store to wiring. Impact: medium (testability + readability). Effort: medium. Risk: medium (touches the hot live-event path; ordering-sensitive). **Not behavior-preserving** if statements are reordered across the boundary.

### P6 — Extract presentational sub-components out of `agent-detail.tsx` (371 LOC)
`features/agents/pages/agent-detail.tsx` holds the page plus `AgentDossierHeader` (~135 LOC), `AgentDossierTabs`, `InlineRegistrationMark`, `SignatureTicks`, `SpecRow`, `DossierStat`. The header alone exceeds the page. Move the dossier presentational pieces to a `components/` sibling. Impact: low-medium (readability). Effort: medium. Risk: low (pure JSX move) but crosses module boundaries → **not behavior-preserving** by our conservative bar.

---

## Code Smells

| # | Location | Smell / Principle | Detail | Risk | Effort |
|---|---|---|---|---|---|
| 1 | `lib/api.ts:15-25`, `features/agents/data.ts:6-14`, `features/projects/data.ts:6-15`, `features/scheduler/pages/scheduler-state.tsx:14-21`, `components/scheduler-state.tsx:12-21` | Duplication / DIP | `BASE_URL` + `fetchJson` re-declared 5× | Med | Med |
| 2 | `features/agents/agent-utils.ts:3-32` ↔ `features/projects/project-utils.ts:3-32` | Duplication (DRY) | `formatActor` + `formatDateTime` byte-identical | Low | Low |
| 3 | `features/agents/types.ts:3,27,38` ↔ `features/projects/types.ts:3,17,32` | Duplication + type drift | `ProvenanceItem`/`CompactJobRecord`/`CompactJobSummary` duplicated, fields drifting | Med | Med |
| 4 | `types/api.ts:326` ↔ `scheduler-state.tsx:5` ↔ `components/scheduler-state.tsx:3` | Duplication / primitive-obsession | `SchedulerStateResponse` 3 definitions, 2 incompatible shapes | Med | Low |
| 5 | `components/scheduler-state.tsx` (whole file, 89 LOC) | Dead code | `SchedulerStatePanel` never imported/routed | Low | Low |
| 6 | `features/jobs/pages/jobs-catalog.tsx:48`, `job-runs-tab.tsx:13`, `job-schedule-tab.tsx:12`, `job-overview-tab.tsx:12` | Duplication | iso→`Intl.DateTimeFormat` short formatter re-implemented ~4× (plus 2 in *-utils) | Low | Low |
| 7 | `features/sessions/store/use-reducer-store.ts` (237 LOC) | SRP | store + reducer + selectors + summary in one file; `reduceDashboardAction` ~88 LOC | Med | Med |
| 8 | `features/agents/pages/agent-detail.tsx` (371 LOC) | SRP / long file | page + 6 presentational components | Low | Med |
| 9 | `features/sessions/lib/mobile-adapter.ts:38-50` (`deriveRowStatus`) | OCP / deep nesting | status collapsed via if-chain over substring matches on `runtime.status` (`includes('launch')`…); magic priority numbers `60/80/10` at `:66` | Low | Low |
| 10 | `features/jobs/pages/jobs-catalog.tsx:25-46` (`describeCron`) | Long method / nesting | cron-prettifier with nested conditionals + magic `parts.length !== 5`; days array inline at `:41` | Low | Low |
| 11 | `features/agents/data.ts:17` | Type laundering | `getAgentDetail(agentId) as unknown as AgentDetailState` defeats the type system | Med | Low |
| 12 | `types/api.ts:308-317` (`JobDetailResponse.lineage`) | Primitive obsession / ISP | 7-field bag, several `Record<string, unknown>` | Low | Med |
| 13 | `features/sessions/components/event-family.ts` (151 LOC) | Mixed concerns | color/tone maps + scope parsing + label/duration/preview formatters in one "event-family" module | Low | Low |
| 14 | `features/agents/personality.ts:36`, `agent-detail.tsx:75,147` | Redundant work | `agentPersonality(...)` recomputed in page and again inside `AgentDossierHeader` from the same inputs | Low | Low |
| 15 | `components/job-flow-canvas/index.tsx:91-99` | Magic numbers | label-box geometry literals (`length*3.4`, `*6.8`, `-14`, `rx=2`); also lane-band offsets `-12/+24` at `:209,:228` | Low | Low |
| 16 | `features/sessions/lib/mobile-adapter.ts:68-104` (`mobileSessionToRow`) | Long method / conditional spread | ~36-line builder with nested optional-spread ternaries; `normalizeTransport` called twice (`:73,:74`) | Low | Low |

---

## Quick Wins (low risk, high signal)

1. **Delete `components/scheduler-state.tsx`** — provably unreferenced dead module (smell #5). Behavior-preserving.
2. **Extract the days-of-week array** in `jobs-catalog.tsx:41` and the `60/80/10` priority numbers in `mobile-adapter.ts:66` into named constants (smells #9, #10). Behavior-preserving.
3. **Hoist `normalizeTransport(s.runtime.transport)`** in `mobile-adapter.ts:73-74` into a local — currently computed twice in the same expression. Behavior-preserving inline/extract.
4. **Compute `agentPersonality` once** in `agent-detail.tsx` and pass the object to `AgentDossierHeader` instead of recomputing from `profile` (smell #14). NOT behavior-preserving (prop-shape change) — defer to apply stage with care.

---

## Tech Debt (larger, schedule deliberately)

- **Shared fetch/util/type kernel.** The viewer has grown feature-first; the cross-cutting primitives (`fetchJson`, `formatActor`/`formatDateTime`, `ProvenanceItem`, Compact job types, iso formatters) want a small shared layer (`lib/format.ts`, `lib/http.ts`, `types/shared.ts`). This is the root cause of smells #1–#4, #6. Medium effort, eliminates the bulk of the duplication grade hit.
- **`use-reducer-store.ts` decomposition** (P5) — extract pure reducer + selectors for unit-testability.
- **Type-launder removal** (`agent-utils`/`data.ts` `as unknown as`) — `getAgentDetail` returns `AgentDetailResponse` but is coerced to `AgentDetailState`; the two shapes should be reconciled or an explicit mapper written.

---

## Safety Checklist (for the downstream apply stage)

- [ ] `pnpm --filter acp-viewer typecheck` (or `tsc -b`) green before/after — several findings touch shared types.
- [ ] `mobile-adapter.test.ts` (229 LOC, the only test) still passes — guards smells #9, #16.
- [ ] Verify `components/scheduler-state.tsx` truly has zero importers before deletion (`grep -rn "scheduler-state'" src` — confirmed at audit time: only `features/scheduler/...` is routed).
- [ ] When unifying `fetchJson`, preserve the **defensive** env accessor used by the `data.ts` copies (not `lib/api.ts`'s bare `import.meta.env`).
- [ ] When merging `CompactJobRecord`/`CompactJobSummary`, keep the union of optional fields — do not drop project-only `lastFireAt`/`createdAt`/`updatedAt`.
- [ ] Live-stream path (`use-reducer-store.ts` reducer) is async/ordering-sensitive — do not reorder `applyEvent`/`compact` calls when extracting.
