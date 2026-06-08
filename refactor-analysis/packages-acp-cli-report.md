# Refactor Analysis — `packages/acp-cli`

ANALYSIS ONLY. No source files were modified. Scope: `packages/acp-cli/src`
(non-test `*.ts`). Total non-test source: **9,178 lines** across ~50 files
(12,853 lines including `__tests__`).

## Scorecard

| Dimension | Rating | Notes |
|---|---|---|
| SRP | Fair | `cli.ts` (687) mixes wiring + commander-shim + dual entrypoints; `server-runtime.ts` (667) is process-lifecycle + token resolution + status + Discord wiring in one file. |
| OCP | Fair | Subcommand dispatch is long `if (subcommand === 'x')` chains (`run.ts`, `job.ts`, `agent.ts`, `server-runtime.ts`). Render symbol selection is `if`-cascade duplicated across plain/markdown. |
| LSP | Good | `AcpClient` has intentional `throw 'route removed'` stubs (`promoteTask`, `listTransitions`) that return `Promise<never>` — typed, not silent LSP breakage, but still a smell. |
| ISP | Poor | `AcpClient` is a 30-method fat interface (`http-client.ts:153-315`); most commands use 1–2 methods. |
| DIP | Good | Dependencies injected via `CommandDependencies` (`createClient`, `fetchImpl`, `env`, `attach`). Concrete `new HrcStoreReader()` and `new GatewayDiscordApp()` are the exceptions. |
| Tests | Good | Substantial `__tests__` coverage (job-run-flow, smoke, timeline-join, hrc-store-reader). |

## Priority Refactorings

### P1 — Duplicated correlation-header builders (`run.ts` ↔ `send.ts`)
`resolveCorrelationHeaders` (`commands/run.ts:124-144`) and
`correlationHeadersFromEnv` (`commands/send.ts:209-227`) build the identical
`HRC_RUN_ID` / `HRC_HOST_SESSION_ID` / `HRC_GENERATION` header map from env with
the same `includeHrcRunId` gate. Extract one shared helper (e.g. into
`commands/shared.ts` or `session-shared.ts`). Pure dedup of identical logic.

### P1 — Duplicated transport primitives (`parseResponseText`, `trimTrailingSlashes`, `readBody`)
`parseResponseText` is defined three times: `commands/shared.ts:102`,
`commands/run.ts:61`, and equivalently as `readBody` in `http-client.ts:358`.
`trimTrailingSlashes` exists in both `http-client.ts:371` and
`commands/shared.ts:98`. The request/error-wrapping flow in
`createHttpClient.request` (`http-client.ts:385-420`) and
`createRawAcpRequester.doFetch` (`commands/shared.ts:122-144`) are near-identical
(headers, actor header, JSON body, transport-error wrapping). Consolidate into a
single transport module. Identical-block dedup.

### P2 — Duplicated HRC anchor-resolution logic (`task-timeline.ts` ↔ `timeline-hrc-join.ts`)
`hasParticipantRunLaunch` + `resolveHrcAnchors` (`commands/task-timeline.ts:163-180`)
duplicate `isParticipantRunLaunch` + `resolvedAnchors` (`output/timeline-hrc-join.ts:265-284`)
byte-for-byte in intent. The command computes anchors only to decide whether to
build the reader, then `joinHrcTimeline` recomputes them internally. Export the
join module's version and reuse. Behavior-equivalent dedup.

### P2 — `cli.ts` duplicated entrypoint error-handling block
The `catch` block in `main` (`cli.ts:643-658`) is duplicated verbatim in the
`import.meta.main` block (`cli.ts:670-685`) — same CommanderError code checks,
same `exitWithError` dispatch. Extract a `handleCliError(err, json)` helper.
Pure extract-function.

### P2 — Magic numbers in timeline join/render
`output/timeline-hrc-join.ts:120` `rows.splice(250, 0, …)` (elision insert index)
and `:329` `length > 3` / `:333` `start: index + 3` (collapse threshold) are bare
literals; `output/timeline-render.ts` uses `width - 55`, `width - 12`, `width - 19`,
`Math.max(24, Math.min(54, …))`, `padStart(3)`, `slice(11,19)`, `maxLines 120/40`.
Name the load-bearing ones (`HRC_ELISION_INSERT_INDEX`, `TOOL_COLLAPSE_THRESHOLD`).
Replace-with-named-const of same value.

### P3 — `addRuntimeCommands` / coordination builders are long but mechanical (`cli.ts`)
`cli.ts` command-registration functions (`addTaskCommands` 102 lines,
`addCoordinationCommands` 119 lines, `addRuntimeCommands` 84 lines) are flat
commander option chains. Not a logic risk, but they couple every subcommand's
flag surface into one module. Optional: split per command-group file. Structural
move (behavior-preserving only if option order/registration is preserved exactly).

### P3 — Render symbol selection duplicated across plain/markdown (`timeline-render.ts`)
`symbolFor` (`:81`), `styledSymbol` (`:98`), and `markdownSymbol` (`:382`) each
re-encode the same category→glyph mapping (`run`, `mapping/effect`, `obligation`,
`anomaly`, `rejected`, default). Drive all three from one category→symbol-set
table. Behavior-equivalent if every glyph is preserved exactly.

## Code Smells

| Smell | Location | Impact |
|---|---|---|
| Long file / mixed concerns | `server-runtime.ts:1-667` | Lifecycle + Discord token (Consul) + status + launchd in one unit. |
| Long file / mixed concerns | `cli.ts:1-687` | Wiring + commander shim + two near-identical entrypoints. |
| Fat interface (ISP) | `http-client.ts:153-315` | 30-method `AcpClient`; consumers use a slice. |
| Long function | `runServerCommand` `server-runtime.ts:554-667` (113 lines) | Command-string dispatch cascade with embedded launchd/mode logic. |
| Long function | `runRunCommand` `commands/run.ts:202-342` (140 lines) | Nested `attachment` sub-dispatch inside run dispatch. |
| OCP if-chain | `job.ts:98-257`, `agent.ts:26-103`, `run.ts:325-341`, `server-runtime.ts:563-666` | String-keyed subcommand `if` cascades; new subcommand = edit central chain. |
| Deep nesting (>=4) | `commands/task-timeline.ts:256-300` | `if !no-hrc { if anchors { try { … } } }` with nested ternaries. |
| Duplicated literal logic | `send.ts:174-207` `readInputIntent` | Repeated string-equality unions for intent/fallback/semantics validation. |
| Magic numbers | `timeline-hrc-join.ts:120,329,333`; `timeline-render.ts:314,347,365` | Unnamed layout/threshold constants. |
| Primitive obsession | `server-runtime.ts:80-128` (`hasFlag`/`valueAfter`/`stripLifecycleArgs`) | Hand-rolled arg scanning instead of the existing `parseArgs` in `options.ts`. |
| Hardcoded path constants | `server-runtime.ts:21-22` | `/Users/lherron/...` absolute defaults baked into source. |
| LSP stub overrides | `http-client.ts:443-445,530-532` | `promoteTask`/`listTransitions` throw "route removed". |
| DIP — concrete collaborator | `task-timeline.ts:281` `new HrcStoreReader(...)`; `server-runtime.ts:386` `new GatewayDiscordApp(...)` | Direct construction; not injected. |

## Quick Wins

1. Dedup correlation-header builders (P1) — single helper, two call sites.
2. Extract `handleCliError` from the two `cli.ts` catch blocks (P2).
3. Name `TOOL_COLLAPSE_THRESHOLD` (=3) and `HRC_ELISION_INSERT_INDEX` (=250) in `timeline-hrc-join.ts`.
4. Remove triplicate `parseResponseText`/`trimTrailingSlashes` (P1) — keep one in a transport util.
5. Reuse `timeline-hrc-join.ts` anchor helpers from `task-timeline.ts` (P2).

## Tech Debt

- **Fat `AcpClient` interface** — splitting into role interfaces (tasks / admin /
  governance / heartbeat) is a real ISP improvement but touches signatures and
  call sites → behavior-risky, defer to a dedicated pass.
- **`server-runtime.ts` decomposition** — process lifecycle, Discord/Consul token
  resolution, and launchd detection should be separate modules; involves async
  ordering and signal handling → not behavior-preserving, plan separately.
- **Hardcoded operator paths** (`server-runtime.ts:21-22`) should come from env
  with a portable default; changes runtime behavior, treat as a fix not a refactor.
- **Subcommand dispatch pattern** — the repeated `if (subcommand === …)` chains
  could become a registry/table (OCP), but that reshapes control flow and error
  paths; behavior-risky.

## Safety Checklist

- [ ] Run `bun test` in `packages/acp-cli` after any change (smoke + job-run-flow + timeline-join cover most surface).
- [ ] `tsc --noEmit` — package is strict-typed; dedups must preserve `exactOptionalPropertyTypes` spread patterns (`...(x !== undefined ? {x} : {})`).
- [ ] When extracting transport helpers, preserve `AcpClientTransportError` vs `AcpClientHttpError` distinction (drives exit codes in `cli-runtime.ts:50-80`).
- [ ] Preserve exact glyphs if collapsing symbol tables (timeline render is snapshot-asserted in tests).
- [ ] Do not reorder commander `.option()` registration when splitting `cli.ts` (help output ordering is observable).
