# Refactor Analysis — `packages/acp-e2e`

**Scope:** SOLID + code-smell audit, ANALYSIS ONLY (read-only).
**Date:** 2026-06-07
**Analyst:** `/refactor-analysis`

---

## 0. Scope & Sizing

This package has **no `src/` directory**; it is a test-only package ("End-to-end ACP MVP defect-fastlane integration tests"). The analyzable TypeScript lives under `test/`. Test bodies are treated as the package's "source" here because the brief targets the package directory and these files carry all the reusable harness/fixture logic.

| File | Lines | Role |
|------|-------|------|
| `test/jobflow-exec.test.ts` | 459 | Exec-step jobflow e2e (test + ~180-line embedded harness) |
| `test/e2e-interface.test.ts` | 451 | Interface binding/ingress/delivery e2e (test + request helpers) |
| `test/jobflow-mvp.test.ts` | 388 | MVP sequence jobflow e2e (test + ~180-line embedded harness) |
| `test/fixtures/seed-stack.ts` | 261 | Shared in-process stack/CLI fixture (real shared code) |
| `test/e2e-workflow-runtime.test.ts` | 117 | CLI workflow-runtime e2e |
| `test/fixtures/mock-launcher.ts` | 66 | Recording mock launcher fixture |
| `test/helpers/raw-wrkq-task.ts` | 13 | Bare wrkq task factory (UNUSED) |
| **Total** | **1755** | |

---

## 1. Scorecard

| Dimension | Grade | Notes |
|-----------|-------|-------|
| SRP | C | `seed-stack.ts` mixes stdout/stderr/exit monkeypatching, env juggling, store wiring, and CLI adapter in one module. |
| OCP | A | No type-keyed switch chains; flow shape is data-driven. |
| LSP | A | The two `override`s (`RecordingInputAttemptStore.createAttempt`) are faithful pass-throughs. |
| ISP | A | No fat interfaces; payload types are wide but are inert DTO shapes. |
| DIP | B | Tests construct concrete stores directly, but that is appropriate for an integration harness; `seed-stack` already injects via `AcpServerDeps`. |
| DRY | **D** | ~180 lines of HRC-fixture + jobflow-CRUD harness duplicated near-verbatim between `jobflow-exec.test.ts` and `jobflow-mvp.test.ts`. |
| Dead code | C | `raw-wrkq-task.ts` (`createBareWrkqBugTask`) has zero references. |
| Magic values | B | A handful of repeated string literals (`'discord_prod'`, `'channel:123'`, timeout `'5000'`) but low blast radius in tests. |

**Overall: C+** — solid integration-test design undermined by one large block of copy-paste duplication and a dead helper.

---

## 2. Priority Refactorings

### P1 — Extract the duplicated jobflow HRC harness into a shared fixture
**Location:** `test/jobflow-exec.test.ts:1-186` ≈ `test/jobflow-mvp.test.ts:1-186`
**Smell:** Duplication (DRY) / shotgun-surgery risk.
A `diff` of lines 1-186 shows the two files are **identical except 5 lines** (temp-dir prefix on `:54`, `hostSessionId`/`sessionId` on `:136`/`:141`, `scopeRef` task id on `:153`, `input.content` on `:156`). Everything else — the type aliases (`LaunchCall`, `FlowLaunchOutcome`, `HeadlessHrcFixture`, `JobRunPayload`), `RecordingInputAttemptStore`, `createHeadlessHrcDb`, `insertTerminalHrcRun`, `createTerminalFlowLauncher`, `createFlowJob`, `runJob`, `getJobRun` — is byte-for-byte duplicated.
**Fix:** Move the shared block to `test/fixtures/jobflow-harness.ts`, parameterizing the 5 varying values (label prefix, session id, scopeRef task id, job input content). Both test files import from it.
**Impact:** Removes ~180 duplicated lines; one place to evolve the HRC fixture schema.
**Effort:** M. **Risk:** Low-Med (mechanical move + parameterize; behavior identical if defaults preserved).

### P2 — Remove dead helper `createBareWrkqBugTask`
**Location:** `test/helpers/raw-wrkq-task.ts:3-13`
**Smell:** Dead code. `grep` across `test/` finds the symbol only at its own definition — no importers.
**Fix:** Delete the file (and `helpers/` dir if it empties).
**Impact:** Removes an unused export and an `acp-core` type import that no test exercises.
**Effort:** S. **Risk:** Low (provably unreferenced).

### P3 — Split `seed-stack.ts` `runCli` global-state shim from the stack builder (SRP)
**Location:** `test/fixtures/seed-stack.ts:89-154` (`runCli`) vs `:173-248` (`createSeedStack`)
**Smell:** Mixed concerns / long function. `runCli` (66 lines) monkeypatches `process.stdout.write`, `process.stderr.write`, `process.exit`, and mutates/`restore`s `process.env` — a "global mutation sandbox" concern unrelated to store wiring. It also re-implements the same env save/restore pattern that `jobflow-exec.test.ts` does in `withExecEnv`/`restoreEnv`.
**Fix:** Extract a `withProcessSandbox(env, fn)` helper (stdout/stderr/exit/env capture+restore) into its own fixture module; `createSeedStack` keeps only store/server wiring.
**Impact:** Clearer separation; reusable env-save/restore removes a second copy of the pattern.
**Effort:** M. **Risk:** Med (touches process-global patching and async ordering — must preserve `finally` restore semantics exactly).

---

## 3. Code Smells

| # | Location | Smell | Detail | Effort | Risk |
|---|----------|-------|--------|--------|------|
| 1 | `jobflow-exec.test.ts:1-186` / `jobflow-mvp.test.ts:1-186` | Duplication | ~180 lines identical bar 5 literals | M | Low-Med |
| 2 | `helpers/raw-wrkq-task.ts:3` | Dead code | `createBareWrkqBugTask` unreferenced | S | Low |
| 3 | `seed-stack.ts:96-153` | Long function / mixed concerns | `runCli` patches 3 process globals + env map | M | Med |
| 4 | `seed-stack.ts:99-153`, `jobflow-exec.test.ts:204-236` | Duplication | Two separate env save/restore implementations | S | Med |
| 5 | `e2e-interface.test.ts:98-99,124-128` | Magic string literals | `'discord_prod'`, `'channel:123'`, `'discord:user:999'` repeated across helpers + assertions | S | Low |
| 6 | `jobflow-exec.test.ts:217-218` | Magic numbers | timeout `'5000'` hardcoded for default + max | S | Low |
| 7 | `seed-stack.ts:194-203` | Repetitive conditional spread | 6× `...(x !== undefined ? { x } : {})` ladder | S | Low |
| 8 | `seed-stack.ts:164,168-169` / `jobflow-exec.test.ts:190,194-196` | Duplication | `defaultRuntimeResolver` and `createRuntimeResolver` are near-identical (only `projectRoot`/`cwd` differ) | S | Low |
| 9 | `e2e-interface.test.ts:6-58` | Wide DTO types | 4 inline payload types (~50 lines) duplicate server response shapes; could import from `acp-interface-store` | M | Med |
| 10 | `jobflow-exec.test.ts:258-323` | Long test body / deep nesting | `withExecEnv`→`withSeedStack`→test reaches 4+ indent levels inside a 65-line `try/finally` | M | Med |

---

## 4. Quick Wins (behavior-preserving)

- **Delete `helpers/raw-wrkq-task.ts`** (P2 / smell #2) — provably dead.
- **Name the timeout constant** in `jobflow-exec.test.ts:217-218` — replace the two `'5000'` literals with one `EXEC_TIMEOUT_MS` const of the same value.
- **Hoist interface literals** in `e2e-interface.test.ts` — extract `GATEWAY_ID = 'discord_prod'`, `CONVERSATION_REF = 'channel:123'` consts; same values, single source.

## 5. Tech Debt (larger / behavior-touching)

- **Shared jobflow harness (P1)** — the big one; pays back every future jobflow test.
- **Process-sandbox extraction (P3)** — consolidates three env/stream/exit patching sites; touches async-ordering so verify under `bun test`.
- **DTO de-duplication (smell #9)** — importing real store types instead of redeclaring narrows drift risk but couples tests to internal types; design decision, not a pure refactor.

## 6. Safety Checklist

- [ ] `bun test` green in `packages/acp-e2e` before and after each change (the only behavioral oracle here).
- [ ] P1 move: confirm the 5 parameterized literals match the originals per file (temp prefix, sessionId, hostSessionId, scopeRef task id, input content).
- [ ] P2 delete: re-run `grep -rn createBareWrkqBugTask` across the repo (not just package) to confirm no cross-package importer.
- [ ] P3: preserve `try/finally` restore order for stdout/stderr/exit/env; do not change await points.
- [ ] Quick-win consts must use the SAME literal values (`'5000'`, `'discord_prod'`, `'channel:123'`).

---

*Analysis only — no source files were modified.*
