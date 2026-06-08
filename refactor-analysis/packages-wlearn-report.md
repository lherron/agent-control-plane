# Refactor Analysis — `packages/wlearn`

**Scope:** `packages/wlearn/src` (TypeScript source, excluding `dist/`, `node_modules/`)
**Files analyzed:** `src/cli.ts` (178), `src/index.ts` (16), `src/__tests__/cli.test.ts` (9)
**Total source lines:** 203
**Mode:** ANALYSIS ONLY (no source edits)

---

## Scorecard

| Dimension | Rating | Notes |
|---|---|---|
| SRP (Single Responsibility) | B− | `runWlearnCli` mixes argument routing, parsing, business invocation, and output for 7 commands in one function. |
| OCP (Open/Closed) | C | Command dispatch is a flat `if (key === '...')` chain; adding a command requires editing the function body. |
| LSP | N/A | No inheritance / overrides. |
| ISP | A | No fat interfaces; types are imported from `acp-core`. |
| DIP | B | `readFileSync`, `process.stdout/stderr/exit` and `acp-core` functions are referenced directly, but this is a thin CLI shell so coupling is mostly acceptable. |
| Code-smell density | B | One long function, an OCP if-chain, and a handful of inline literals; otherwise clean. |
| Test coverage | D | A single test covering only the unknown-command path; no coverage of any of the 7 command handlers or the arg parser. |

**Overall:** B−. This is a small, intentionally thin CLI veneer over `acp-core`. The dominant issue is the monolithic dispatch function (`runWlearnCli`), which is both an SRP and an OCP smell. Everything else is minor.

---

## Priority Refactorings

### P1 — Decompose `runWlearnCli` command dispatch (SRP + OCP)
- **Location:** `src/cli.ts:74-168`
- **Smell:** Long method (~94 lines) and a type-keyed `if (key === '...')` chain handling 7 distinct commands plus help/unknown fallthrough. Each new command requires editing this function.
- **Impact:** High — central control-flow point; hard to read, hard to extend, every handler shares one scope.
- **Risk:** Medium — extracting handlers into a `Record<string, (flags) => unknown>` table changes control-flow structure and ordering of the `help`/unknown checks; must preserve exact thrown-message semantics and the `help`/empty-key precedence.
- **Effort:** M
- **behaviorPreserving:** false (restructures dispatch and error precedence; verify against the unknown-command test plus added handler tests).

### P2 — Extract per-command handler functions (SRP)
- **Location:** `src/cli.ts:78-161`
- **Smell:** Each command block (trace materialize, replay run, hrc summarize-range, playbook draft, patch draft, curate report, promotion submit) is an inlined unit mixing flag extraction with `printJson`. Extracting each into a named `handleX(flags)` function is a behavior-preserving extract-function.
- **Impact:** Medium — improves readability and unlocks the P1 dispatch-table approach.
- **Risk:** Low — pure extraction; same logic, same output, same throws.
- **Effort:** S
- **behaviorPreserving:** true (extract-function only, identical behavior per block).

---

## Code Smells

| # | Location | Smell / Principle | Detail | Risk | Effort |
|---|---|---|---|---|---|
| 1 | `src/cli.ts:74-168` | Long method / SRP | `runWlearnCli` ~94 lines, 7+ responsibilities. | Med | M |
| 2 | `src/cli.ts:78-161` | OCP | Flat `if (key === '...')` dispatch chain; closed for extension. | Med | M |
| 3 | `src/cli.ts:113,124,151` | Magic number | `authorityTier: 2`, `authorityTier: 3`, and `startSeq`/`endSeq` numeric coercion — tier literals lack named constants tying them to the acp-core authority model. | Low | S |
| 4 | `src/cli.ts:46` | Primitive obsession / duplicated literal | Actor-kind union (`'agent' | 'human' | 'service' | 'group'`) is inlined as a string-equality chain rather than checked against a shared `ActorRef` kind constant/set from `acp-core`. | Low | S |
| 5 | `src/cli.ts:99-105,108-117,119-129,131-139` | Duplication | Four handlers build an ad-hoc literal object then `printJson` with a hardcoded `note` string; structurally near-identical "static-response" shape. | Low | S |
| 6 | `src/cli.ts:16,19` | Mixed equality style | `token?.startsWith('--') === true` (explicit `=== true`) vs `value.startsWith('--')` (implicit) — inconsistent boolean handling in the same parser. | Low | S |
| 7 | `src/cli.ts:43-53` | Boolean complexity | `parseActor` uses a 3-clause `&&` guard with an inline union; readable but could be a guard-clause + lookup. | Low | S |
| 8 | `src/cli.ts:170-178` | DIP (acceptable) | Direct `process.stderr`/`process.exit` at module entrypoint — standard for a CLI `main`, noted not flagged for change. | Low | — |

---

## Quick Wins

1. **Extract command handlers** (`src/cli.ts:78-161`) — pure extract-function per command block; no behavior change, immediately improves readability. (behaviorPreserving)
2. **Name the magic tier numbers** (`src/cli.ts:113,124`) — replace `authorityTier: 2 / 3` with named constants of the same value (e.g. `PLAYBOOK_AUTHORITY_TIER`, `PATCH_AUTHORITY_TIER`). (behaviorPreserving)
3. **Normalize boolean checks** (`src/cli.ts:16` vs `19`) — make the two `startsWith('--')` checks consistent (drop the redundant `=== true` or apply uniformly). (behaviorPreserving — equivalent boolean simplification)

---

## Tech Debt

- **Test coverage gap:** Only the unknown-command path is exercised (`__tests__/cli.test.ts:6`). None of the 7 command handlers, `parseArgs`, `requireFlag`, `parseActor`, or `parsePatchBundle` have tests. Any P1 dispatch refactor is risky without first adding handler-level tests. Recommend adding a characterization test per command before restructuring.
- **Static-response handlers:** `hrc summarize-range`, `playbook draft`, `patch draft`, `curate report` emit hardcoded literal envelopes with explanatory `note` strings — these are placeholders/stubs. Worth tracking whether they are intended to remain static or be wired to `acp-core` (potential dead-ish/stub code).

---

## Safety Checklist (for downstream apply stage)

- [ ] Preserve exact thrown-error messages (`unknown wlearn command: ${key}`, `--${name} is required`, `missing value for --${key}`, `invalid actor, expected kind:id`) — they are asserted in tests and likely scripted against.
- [ ] Preserve the `help` / empty-key / `--help` precedence at `src/cli.ts:163-165` BEFORE the unknown-command throw at `:167`.
- [ ] Preserve JSON output shape and the trailing newline from `printJson` (`src/cli.ts:60`).
- [ ] Keep the conditional-spread pattern for optional flags (`candidate`, `external-authority`) so absent flags do NOT appear as `undefined` keys (`src/cli.ts:92,153`).
- [ ] Run `bun test` in `packages/wlearn` after any change; add handler tests before attempting P1.
- [ ] Magic-number renames must use the SAME literal value (2 stays 2, 3 stays 3).
