# Commander CLI Upgrade — Implementation Spec

Status: Phases 0–6 complete (2026-04-27)
Owner: TBD
Last updated: 2026-04-27

## 1. Background & motivation

The `agent-spaces` monorepo currently ships **four separate CLIs**, three of which hand‑roll their own argv parser. The hand‑rolled parsers diverged over time and now expose three different APIs that solve overlapping problems. Help text is built by ~60 hand‑written `renderXxxHelp` helpers in `acp-cli` alone, and the largest CLI (`hrc-cli`) has 2,708 lines of production code paired with a 2,707‑line test file that pins exact help‑text strings.

We will consolidate all four CLIs on **commander v14**, the industry‑standard JavaScript/TypeScript CLI framework (~245M weekly npm downloads, first‑class TS generics since v13). One of our four CLIs (`packages/cli`) is already on commander v12; the other three migrate from bespoke parsers to commander, and `packages/cli` bumps 12 → 14.

### Goals

1. One parser across the monorepo.
2. Auto‑generated, consistent `--help` output.
3. Type‑safe option access (`cmd.opts<T>()`).
4. Delete ~500 LOC of bespoke parsing + help‑text boilerplate.
5. **Bit‑identical** public CLI surface during migration: same verbs, same flag names, same exit codes, same JSON output shapes.

### Non‑goals

- No new commands; no restructured subcommand trees.
- No JSON output shape changes.
- No migration of `wrkq` (Go).
- No new "ASP CLI framework" abstraction over commander — defer until after all four packages are migrated.

## 2. Current state inventory

| Package | Bin | LOC (src) | Commands | Parser today | Test risk |
|---|---|---|---|---|---|
| `packages/cli` | `asp` | ~5,800 | ~25 (nested: `repo`, `self`, `spaces`) | **commander ^12** | Medium — `commands/self/__tests__/*.test.ts` |
| `packages/acp-cli` | `acp` | ~5,800 | ~30 modules, 4 levels deep | Hand‑rolled `cli-args.ts` (typed `parseArgs(spec)` API) | Medium‑High — 60+ help renderers likely asserted in command tests |
| `packages/hrc-cli` | `hrc` | ~4,400 (one 2,708‑line `cli.ts`) | ~20 verbs over `server`, `agent`, `lane`, `event` | Hand‑rolled `cli-args.ts` (`parseFlag`, `hasFlag`, `parseIntegerFlag`) | **High** — `__tests__/cli.test.ts` is 2,707 lines |
| `packages/hrcchat-cli` | `hrcchat` | ~1,100 | 12 flat verbs (`dm`, `who`, `summon`, …) | Hand‑rolled `cli-args.ts` (`extractPositionals`, `consumeBody`, `parseDuration`) | Low — only `__tests__/normalize.test.ts` |

### 2.1 Files to read before starting

Required reading per CLI:

**`packages/acp-cli`**
- `src/cli.ts` — top‑level dispatch, all `renderXxxHelp` helpers (1,352 lines)
- `src/cli-args.ts` — parser (168 lines)
- `src/cli-runtime.ts` — `CliUsageError`, `exitWithError`, `writeCommandOutput`
- `src/commands/shared.ts` — `CommandDependencies`, `resolveEnv`, `resolveServerUrl`, `requireActorAgentId`, `maybeParseMetaFlag`, `asJson`, `asText`, `getClientFactory`
- `src/commands/task-create.ts` — representative command shape (good migration template)
- `src/index.ts` — entry point

**`packages/hrc-cli`**
- `src/cli.ts` (2,708 lines) — production code
- `src/cli-args.ts` (58 lines) — parser
- `src/cli-runtime.ts` (417 lines) — server lifecycle helpers (KEEP, not parser)
- `src/__tests__/cli.test.ts` (2,707 lines) — primary test surface
- monitor command modules — snapshot/watch/wait output surface

**`packages/hrcchat-cli`**
- `src/main.ts` (144 lines) — top‑level dispatch
- `src/cli-args.ts` (134 lines) — parser
- `src/commands/*.ts` (12 files) — handlers
- `src/__tests__/normalize.test.ts` — only test file

**`packages/cli`**
- `src/index.ts` (149 lines) — already commander, just version bump
- `src/commands/self/__tests__/cli.test.ts` (209 lines) — verify post‑bump

### 2.2 Files importing the hand‑rolled parsers (31 total)

```
packages/acp-cli/src/commands/admin-governance-shared.ts
packages/acp-cli/src/commands/admin-interface-binding-disable.ts
packages/acp-cli/src/commands/admin-interface-binding-list.ts
packages/acp-cli/src/commands/admin-interface-binding-set.ts
packages/acp-cli/src/commands/admin-interface-binding-shared.ts
packages/acp-cli/src/commands/agent.ts
packages/acp-cli/src/commands/delivery.ts
packages/acp-cli/src/commands/heartbeat.ts
packages/acp-cli/src/commands/interface-identity.ts
packages/acp-cli/src/commands/job-run.ts
packages/acp-cli/src/commands/job.ts
packages/acp-cli/src/commands/membership.ts
packages/acp-cli/src/commands/message.ts
packages/acp-cli/src/commands/project.ts
packages/acp-cli/src/commands/render.ts
packages/acp-cli/src/commands/run.ts
packages/acp-cli/src/commands/runtime.ts
packages/acp-cli/src/commands/send.ts
packages/acp-cli/src/commands/session.ts
packages/acp-cli/src/commands/system-event.ts
packages/acp-cli/src/commands/tail.ts
packages/acp-cli/src/commands/task-create.ts
packages/acp-cli/src/commands/task-evidence-add.ts
packages/acp-cli/src/commands/task-promote.ts
packages/acp-cli/src/commands/task-show.ts
packages/acp-cli/src/commands/task-transition.ts
packages/acp-cli/src/commands/task-transitions.ts
packages/acp-cli/src/commands/thread.ts
packages/hrcchat-cli/src/commands/dm.ts
packages/hrcchat-cli/src/commands/doctor.ts
packages/hrcchat-cli/src/commands/info.ts
packages/hrcchat-cli/src/commands/messages.ts
packages/hrcchat-cli/src/commands/peek.ts
packages/hrcchat-cli/src/commands/send.ts
packages/hrcchat-cli/src/commands/show.ts
packages/hrcchat-cli/src/commands/summon.ts
packages/hrcchat-cli/src/commands/who.ts
```

(Plus `hrc-cli/src/cli.ts` — single‑file CLI.)

### 2.3 The three hand‑rolled parser APIs

All three need replacement; here's what they currently expose so the migration knows what to swap.

**`acp-cli/src/cli-args.ts`** (richest):
```ts
parseArgs(args, { booleanFlags, stringFlags, multiStringFlags }) → ParsedArgs
hasFlag(parsed, flag): boolean
readStringFlag(parsed, flag): string | undefined
readMultiStringFlag(parsed, flag): string[]
requireStringFlag(parsed, flag): string
requireNoPositionals(parsed): void
parseIntegerValue(flag, raw, { min }): number
parseJsonObject(flag, raw): Record<string, unknown>
parseCommaList(raw, flag): string[]
```

**`hrc-cli/src/cli-args.ts`** (minimal):
```ts
fatal(message): never
printJson(value): void
requireArg(args, index, name): string
parseFlag(args, flag): string | undefined
hasFlag(args, flag): boolean
parseIntegerFlag(args, flag, { defaultValue, min? }): number
```

**`hrcchat-cli/src/cli-args.ts`** (positional‑aware):
```ts
fatal(message): never
printJson(value): void
extractPositionals(args, valueFlags): string[]
requireArg(args, index, name, valueFlags): string
parseFlag(args, flag): string | undefined
hasFlag(args, flag): boolean
parseIntegerFlag(args, flag, { defaultValue, min? }): number
consumeBody(args, startIndex, valueFlags): string | undefined  // stdin / --file / positional
parseDuration(input): number
```

`consumeBody` and `parseDuration` are **not parser concerns** and should be lifted into the shared kit (Phase 0); they're called from action handlers regardless of which parser is in use.

## 3. Target

**`commander` `^14.0.0`**, the standard package (not `@commander-js/extra-typings`).

Rationale: v13/v14 added built‑in TS generic inference for `cmd.opts<T>()`; `extra-typings` is unnecessary. Staying on the canonical package keeps types and docs in sync.

`packages/cli` is currently on `^12.1.0`; bump as part of Phase 4. v12 → v14 is mostly help‑output formatting tweaks and minor API renames — verifiable via the existing tests.

## 4. Migration strategy — phased

Five phases, smallest‑risk first, one PR per phase.

### Phase 0 — Shared kit (½–1 day)

**Add a new package** `packages/cli-kit` (TypeScript, depends only on `commander`) **OR** extend `acp-core` if we'd rather avoid a new workspace. Recommendation: **new package**, because hrc‑cli must not transitively depend on acp‑core.

Exports:

```ts
// commander helpers
export function attachJsonOption(cmd: Command): Command
export function attachServerOption(cmd: Command, defaultUrl?: string): Command
export function attachActorOption(cmd: Command): Command
export function repeatable<T = string>(parse?: (raw: string) => T):
  (value: string, prev: T[] | undefined) => T[]
export function withDeps<D, R>(
  handler: (opts: any, args: string[], deps: D) => Promise<R>,
  buildDeps: () => D
): (...args: any[]) => Promise<void>

// validators (lifted from existing parsers)
export function parseDuration(input: string): number          // from hrcchat-cli
export function parseJsonObject(flag: string, raw: string): Record<string, unknown>  // from acp-cli
export function parseCommaList(raw: string, flag: string): string[]   // from acp-cli
export function parseIntegerValue(flag: string, raw: string, opts: { min: number }): number

// stdin / file body helper (handlers call this; not commander's job)
export function consumeBody(opts: {
  positional?: string
  file?: string
}): string | undefined

// error envelope
export class CliUsageError extends Error {}
export function exitWithError(err: unknown, opts: { json?: boolean; binName: string }): never
```

Tests: unit tests for each pure function. No CLI tests yet.

**Deliverable:** `packages/cli-kit` published in the workspace, no consumers yet.

### Phase 1 — `hrcchat-cli` (½ day)

Smallest, flattest, weakest test coverage. Use as the **reference implementation** of the new pattern.

**Steps:**

1. Add `commander: ^14.0.0` and `cli-kit: *` to `packages/hrcchat-cli/package.json`.
2. Replace `src/main.ts`'s `switch (command)` with a commander tree.
3. For each `commands/*.ts`, change the signature from `cmdXxx(client, args: string[])` to `cmdXxx(client, opts: XxxOptions, positionals: string[])`. Delete in‑file argv parsing.
4. Delete `src/cli-args.ts` (134 lines). The `fatal` and `printJson` helpers move into `cli-kit` (or stay as a 5‑line local file if preferred).
5. Update `src/__tests__/normalize.test.ts` if it touches argv. (It probably doesn't — `normalize.ts` is semantic.)

**Reference pattern** (drop into `src/main.ts`):

```ts
#!/usr/bin/env bun
import { Command } from 'commander'
import { CliUsageError, exitWithError, parseDuration, attachJsonOption } from 'cli-kit'
import { HrcDomainError } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { cmdDm } from './commands/dm.js'
// … other imports

const program = new Command()
  .name('hrcchat')
  .description('semantic directed messaging for HRC agents')
  .exitOverride((err) => { throw err })   // we own exit codes

attachJsonOption(program)

program.command('info')
  .description('show CLI/runtime info')
  .action(() => cmdInfo())

program.command('who')
  .description('list agents')
  .option('--discover')
  .option('--all-projects')
  .action(async (opts) => {
    const client = new HrcClient(discoverSocket())
    await cmdWho(client, opts)
  })

program.command('dm <target> [message]')
  .description('direct message an agent')
  .option('--respond-to <kind>', 'human|agent|system')
  .option('--wait')
  .option('--timeout <duration>', 'e.g. 30s, 5m', parseDuration)
  .option('--file <path>')
  .action(async (target, message, opts) => {
    const client = new HrcClient(discoverSocket())
    await cmdDm(client, { target, message, ...opts })
  })

// … one block per verb

try {
  await program.parseAsync(process.argv)
} catch (err) {
  if (err instanceof HrcDomainError) {
    exitWithError(new Error(`[${err.code}] ${err.message}`), { json: false, binName: 'hrcchat' })
  }
  exitWithError(err, { json: program.opts().json, binName: 'hrcchat' })
}
```

**Deliverable:** `hrcchat-cli` on commander, `cli-args.ts` deleted, behavioral tests pass.

### Phase 2 — `acp-cli` (3–4 days)

The high‑value, medium‑risk one. Target the same pattern.

**Steps:**

1. Add `commander: ^14.0.0` and `cli-kit: *` to `packages/acp-cli/package.json`.
2. Build the command tree top‑down in a new `src/cli.ts`. Subcommand groups become `program.command('task').command('create')`. Multi‑level (e.g. `acp admin interface binding set`) is straightforward: chained `.command()` calls.
3. For each `commands/*.ts`, rewrite the entry signature:
   - **Before:** `runXxxCommand(args: string[], deps: CommandDependencies = {})`
   - **After:** `runXxxCommand(opts: XxxOptions, positionals: string[], deps: CommandDependencies = {})`
4. Inside each handler, replace lines like:
   ```ts
   const parsed = parseArgs(args, { stringFlags: ['--actor', '--server', …] })
   const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
   ```
   with:
   ```ts
   const actorAgentId = requireActorAgentId(opts.actor, env)
   ```
   The validation logic in `commands/shared.ts` (`requireActorAgentId`, `resolveServerUrl`, `maybeParseMetaFlag`) stays as‑is; only the input shape changes.
5. **Delete all 60+ `renderXxxHelp` helpers** in `cli.ts`. Commander's auto‑generated help replaces them.
6. Hoist cross‑cutting options (`--server`, `--actor`, `--json`) to **persistent options** at the appropriate ancestor commands. Commander supports this via `cmd.option(...).hook('preAction', …)` or simply by declaring them on the parent and reading via `cmd.optsWithGlobals()`.
7. Repeatable flags (e.g. `--role implementer:larry --role tester:cody` in `acp task create`, `--to-agent` in `acp message broadcast`):
   ```ts
   .option(
     '--role <assignment>',
     'role:agentId (repeatable)',
     repeatable(),  // from cli-kit
     []
   )
   ```
   Then `opts.role` is `string[]`. `parseRoleAssignment` (already in `roles.ts`) stays untouched.
8. Delete `src/cli-args.ts` (168 lines). Slim `src/cli-runtime.ts` to keep only `writeCommandOutput`, `CliUsageError`, `exitWithError` — and consider moving those into `cli-kit` too.
9. Update tests: see § 6.

**Reference command migration** — `commands/task-create.ts`:

Before (excerpt):
```ts
export async function runTaskCreateCommand(args: string[], deps: CommandDependencies = {}) {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--preset', '--preset-version', '--risk-class', '--project',
                  '--actor', '--kind', '--meta', '--server'],
    multiStringFlags: ['--role'],
  })
  requireNoPositionals(parsed)
  const actorAgentId = requireActorAgentId(readStringFlag(parsed, '--actor'), env)
  const presetVersion = parseIntegerValue('--preset-version',
    requireStringFlag(parsed, '--preset-version'), { min: 1 })
  // … etc
}
```

After:
```ts
type TaskCreateOptions = {
  preset: string
  presetVersion: number
  riskClass: RiskClass
  project: string
  actor?: string
  kind?: string
  meta?: string
  server?: string
  role: string[]
  json?: boolean
}

export async function runTaskCreateCommand(
  opts: TaskCreateOptions,
  deps: CommandDependencies = {}
) {
  const env = resolveEnv(deps)
  const actorAgentId = requireActorAgentId(opts.actor, env)
  const serverUrl = resolveServerUrl(opts.server, env)
  if (!ALLOWED_RISK_CLASSES.has(opts.riskClass)) {
    throw new CliUsageError('--risk-class must be one of: low, medium, high')
  }
  // … same body, just reading from opts
}
```

And the wiring in `cli.ts`:
```ts
program.command('task').command('create')
  .description('create a preset-driven ACP workflow task')
  .requiredOption('--preset <id>')
  .requiredOption('--preset-version <n>', 'integer ≥ 1', (v) => parseIntegerValue('--preset-version', v, { min: 1 }))
  .requiredOption('--risk-class <class>', 'low|medium|high')
  .requiredOption('--project <projectId>')
  .option('--actor <agentId>')
  .option('--kind <kind>', 'task|bug|spike|chore', 'task')
  .option('--meta <json>')
  .option('--server <url>')
  .option('--role <assignment>', 'role:agentId (repeatable)', repeatable(), [])
  .option('--json')
  .action(async (opts) => {
    writeCommandOutput(await runTaskCreateCommand(opts))
  })
```

**Deliverable:** `acp-cli` on commander, `cli-args.ts` deleted, ~370 LOC of `renderXxxHelp` boilerplate gone, all tests green.

### Phase 3 — `hrc-cli` (4–5 days)

Highest risk because of the 2,707‑line test file.

**Steps:**

1. **Test triage first.** Before changing production code, sweep `src/__tests__/cli.test.ts` and classify every assertion:
   - **Behavioral** — exit codes, JSON output, side effects on the tmux/socket/sqlite layer. Keep as is.
   - **Help text exact match** — `expect(stdout).toBe('…')` or `.toEqual('…')` containing `Usage:` or option descriptions. **Loosen to `toContain`** before migrating.
   Expect ~200–400 assertions in the (b) bucket.
2. Add `commander: ^14.0.0` and `cli-kit: *` to `packages/hrc-cli/package.json`.
3. Migrate `src/cli.ts` the same way as `acp-cli`. The verb tree is flatter (mostly `hrc <noun> <verb>`); subcommand groups: `server`, `agent`, `lane`, `event`.
4. **Keep `src/cli-runtime.ts` intact** — it's server lifecycle (`collectServerRuntimeStatus`, `daemonizeAndWait`, `stopServerProcess`, launchd helpers). Not parser concerns.
5. Keep the monitor command modules intact; parser migration should not change monitor behavior.
6. Delete `src/cli-args.ts` (58 lines).
7. Re‑run the test file. Expect:
   - All behavioral assertions to pass unchanged (if they don't, the action handler is being called wrong — investigate before adjusting tests).
   - Loosened help‑text assertions to pass.
8. Cross‑check `src/__tests__/cli-intent.test.ts` (95 lines) — this looks like intent resolution, not arg parsing, so it should be unaffected.
9. Cross‑check `src/__tests__/launchd.test.ts` (136 lines) — server lifecycle, unaffected.

**Deliverable:** `hrc-cli` on commander, all four test files green.

### Phase 4 — `packages/cli` bump 12 → 14 (½ day)

**Steps:**

1. `bun add commander@^14.0.0` in `packages/cli`.
2. Run `bun run --filter '@lherron/agent-spaces' test`. Expect a small number of `commands/self/__tests__/*` snapshot mismatches due to v14 help‑output formatting.
3. Adopt the Phase 0 helpers — replace any local duplicates of `parseDuration`, `parseJsonObject`, etc. with `cli-kit` exports.
4. Verify `bin/asp.js` still works end‑to‑end: `asp --help`, `asp self --help`, `asp run …`.

**Deliverable:** `packages/cli` on commander 14 with shared helpers.

### Phase 5 — Final cleanup (½ day)

**Steps:**

1. Confirm these files no longer exist:
   - `packages/acp-cli/src/cli-args.ts`
   - `packages/hrc-cli/src/cli-args.ts`
   - `packages/hrcchat-cli/src/cli-args.ts`
2. Slim or remove `packages/acp-cli/src/cli-runtime.ts` if its only remaining contents are now in `cli-kit`.
3. `grep -rn "renderXxxHelp\|hand-rolled" packages/` and remove any stale references.
4. Run `bun run build` (the ordered build) to confirm no broken imports.
5. Run `bun run typecheck`.
6. Run `bun run test`.
7. Update root `package.json` `"build:ordered"` script to add `cli-kit` between `acp-core` and the CLI packages.
8. Add a `CHANGELOG.md` entry under each affected package noting the migration. Help‑text format change is the only user‑visible diff.

**Deliverable:** Clean tree, all builds pass.

### Phase 6 — `hrc-cli` legacy‑passthrough sub‑tree migration

Phase 3 moved `hrc-cli` to commander at the **outer** level only. Nine subcommand groups remain wired through the `addLegacyCommand()` helper at `packages/hrc-cli/src/cli.ts:3235-3256`, which deliberately disables auto‑help (`.helpOption(false)`) and forwards all argv into the legacy switch dispatcher (`.allowUnknownOption(true)` + `.argument('[args...]')`).

Result — these nine groups violate the §9 user‑facing acceptance line ("`<bin> <verb> --help` … all produce sensible output"):

| Sub‑group | `hrc <group> --help` observed | `hrc <group> <verb> --help` observed |
|---|---|---|
| `hrc server`   | exit 2, no `Usage:` line | runs the verb instead of emitting help |
| `hrc session`  | exit 2, no `Usage:` line | runs the verb |
| `hrc runtime`  | exit 2, no `Usage:` line | runs the verb |
| `hrc launch`   | exit 2, no `Usage:` line | runs the verb |
| `hrc turn`     | exit 2, no `Usage:` line | runs the verb |
| `hrc inflight` | exit 2, no `Usage:` line | runs the verb |
| `hrc capture`  | exit 1 | runs the verb |
| `hrc surface`  | exit 2, no `Usage:` line | runs the verb |
| `hrc bridge`   | exit 2, no `Usage:` line | runs the verb |

asp/acp/hrcchat all pass this acceptance check (38/38 top‑level verbs sampled). hrc passes for its commander‑native verbs (`info`, `status`, `events`, `start`, `run`, `attach`). Only the nine `addLegacyCommand` groups fail.

**Steps:**

1. Pick `hrc server` as the reference (smallest group: `start`, `serve`, `stop`, `restart`, `status`, `health`, `tmux status`, `tmux kill`). Replace the `addLegacyCommand(program, 'server', cmdServer, …)` registration with a proper commander group:
   ```ts
   const server = program
     .command('server')
     .description('daemon lifecycle, health, and tmux backend control')

   server.command('start')
     .description('start the HRC server')
     .option('--foreground')
     .action(async (opts) => cmdServerStart(toLegacyArgv(opts), 'foreground'))

   server.command('serve')
     .description('serve in foreground (no fork)')
     .action(async (opts) => cmdServerServe(toLegacyArgv(opts)))

   // …one block per verb
   ```
   Drop the `cmdServer(args)` switch — route directly from each verb's action to the existing `cmdServerStart` / `cmdServerServe` / … functions. Keep handler signatures stable so behavior assertions in `cli.test.ts` continue to pass.

2. Repeat for the remaining 8 groups: `session`, `runtime`, `launch`, `turn`, `inflight`, `capture`, `surface`, `bridge`. They share the same shape; once the `server` reference is locked, the rest mostly mechanical.

3. After the last group migrates, delete `addLegacyCommand` and any helpers it pulled in. Confirm `grep -n addLegacyCommand packages/hrc-cli/src/` returns no matches.

4. **Behavioral parity is non‑negotiable.** Each migrated verb must produce byte‑identical JSON output and exit codes versus pre‑Phase‑6. The 135 BEHAVIORAL assertions established in Phase 1 (T‑01273) must all stay green. Loosen only any *new* exact‑match help‑text assertions you introduce.

5. **Verification — exhaustive `--help` sweep:**
   ```bash
   for cmd in $(hrc --help | awk '/^Commands:/{f=1;next} /^$/{f=0} f{print $1}' | grep -v '^help$'); do
     hrc $cmd --help >/dev/null 2>&1
     printf "hrc %s --help: exit=%d\n" "$cmd" "$?"
   done
   # Then probe one verb per migrated group, e.g.:
   hrc server status --help; echo "exit=$?"
   ```
   All entries must exit 0 and emit a `Usage:` line.

6. Update `scripts/cli-smoke.sh` (added in Wave 4.5) to add per‑group help assertions for the nine groups.

**Deliverable:** All hrc subcommand groups serve commander‑auto‑generated help; `addLegacyCommand` removed; spec §9 user‑facing acceptance fully satisfied.

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Help‑text exact‑match assertions break en masse | High | Medium | Phase 3 step 1: loosen assertions to `toContain` **before** touching production code. |
| Exit code drift on usage errors (commander defaults to 1, we want 2) | Medium | Medium | `program.exitOverride()` + central `exitWithError()` in `cli-kit` enforces our contract. |
| `=`‑form flags (`--scope-ref=foo`) parse differently | Low | High | Commander handles natively; smoke‑test fixtures (§ 6.3) catch any drift. |
| Repeatable flag semantics differ (`--role` accumulating) | Medium | Medium | `repeatable()` helper in `cli-kit` matches existing `multiStringFlags` behavior; cover with unit tests. |
| `--` passthrough behavior | Medium | Medium | Commander supports via `passThroughOptions()`/`allowUnknownOption()`; verify per command, esp. anywhere we forward to a child process. |
| Stdin / `--file` body handling regresses | Low | High | `consumeBody` lifted into `cli-kit` and called from action handlers — unchanged from today. |
| Bundle size growth on `@lherron/agent-spaces` | Low | Low | `commander` is already a dep; net change ~0. Internal CLIs don't ship to users. |
| External scripts grepping `--help` text break | Medium | Low | Document in CHANGELOG; verbs and flag names don't change, only formatting. |
| TypeScript strictness on `cmd.opts<T>()` | Low | Low | Define per‑command `Options` type alongside the action handler. Net win over today's loose `Record<string, string>`. |
| Build order regression | Low | Medium | Add `cli-kit` to `package.json` `build:ordered` script in Phase 5. |

## 6. Test strategy

### 6.1 Behavioral parity over textual parity

Treat every help string as fungible. Behavior (exit code, JSON output, side effects) is the contract. Help formatting is not.

### 6.2 Pre‑migration test sweep (per CLI)

Before changing production code in any of the three target CLIs:

```bash
# Find help-text exact-match assertions
rg -n "expect\(.*stdout.*\)\.toBe\(|toEqual\(['\"].*Usage:" packages/<cli>/src/__tests__/

# Find usage-error exact-match assertions
rg -n "expect\(.*stderr.*\)\.toBe\(" packages/<cli>/src/__tests__/
```

For each match, convert to one of:
```ts
expect(stdout).toContain('--scope-ref')
expect(stdout).toMatch(/usage: acp task create/i)
expect(exitCode).toBe(2)         // our usage-error contract
expect(JSON.parse(stdout)).toMatchObject({ error: { code: 'usage' } })
```

Land this PR **first**, separate from production changes. It should be a no‑op against the old parser.

### 6.3 Smoke‑test fixtures

For each CLI, before migration, add a **smoke test** that invokes 5–10 representative commands and captures `(exitCode, stdout, stderr, json?)`. Examples:

`packages/acp-cli/src/__tests__/smoke.test.ts`:
```ts
test('acp task create produces structured response', async () => {
  const result = await runCli(['task', 'create', '--preset', 'code_defect_fastlane', …])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ task: { id: expect.any(String) } })
})
```

Run pre‑ and post‑migration; any drift is a real bug.

### 6.4 Specific behaviors to cover per CLI

- **Repeatable flags:** `acp task create --role implementer:larry --role tester:cody` → both roles captured.
- **Comma lists:** wherever `parseCommaList` is used today, verify the new path returns the same array.
- **JSON option flag:** `--json` at top level vs. on a subcommand — commander needs `optsWithGlobals()` to read it from a child action; confirm with a test.
- **`--` passthrough:** if any commands forward args to a child process, write a test that includes `--` and arguments after.
- **Stdin body:** `hrcchat dm <target> -` reads stdin; verify in a test using a piped subprocess.
- **`--file` body:** `hrcchat dm <target> --file foo.txt` reads from disk; verify.
- **Duration parsing:** `--timeout 30s`, `5m`, `1h`, `100ms`; an invalid input must exit non‑zero with our error envelope.
- **Integer validation:** `--preset-version 0` should fail with our exact error code (we have a `min: 1` constraint today).
- **Exit codes:**
  - `0` on success
  - `1` on runtime error (network, server, etc.)
  - `2` on usage error (currently our convention via `CliUsageError`)
  - Confirm via `program.exitOverride()` + central `exitWithError`.

## 7. Effort estimate

| Phase | Days |
|---|---|
| Phase 0 — shared kit | 0.5–1 |
| Phase 1 — hrcchat-cli | 0.5 |
| Phase 2 — acp-cli | 3–4 |
| Phase 3 — hrc-cli | 4–5 |
| Phase 4 — packages/cli bump | 0.5 |
| Phase 5 — cleanup | 0.5 |
| **Buffer for test churn** | 1–2 |
| **Total** | **~10–13 engineer-days** |

## 8. PR sequencing

Each phase is one PR, independently revertable, no feature flags needed (CLIs are internal tools).

| PR | Title | Phases | Notes |
|---|---|---|---|
| 1 | feat(cli-kit): add shared CLI helpers | Phase 0 | New package, no consumers yet |
| 2 | refactor(hrcchat-cli): migrate to commander | Phase 1 | Reference implementation |
| 3 | refactor(acp-cli): migrate to commander | Phase 2 | Biggest LOC delta (deletes ~530 lines) |
| 4 | refactor(hrc-cli): migrate to commander | Phase 3 | Highest test churn |
| 5 | chore(cli): bump commander 12 → 14 + adopt cli-kit | Phase 4 + 5 | Final cleanup, doc updates |
| 6 | refactor(hrc-cli): migrate legacy passthrough sub‑tree to commander | Phase 6 | Closes spec §9 user‑facing acceptance gap (9 hrc groups) |

PRs 2–4 should each be preceded by their **test‑sweep PR** (loosen exact‑match assertions to `toContain`). Those are no‑op and can land same day.

## 9. Acceptance criteria

A reviewer should be able to verify the migration is complete by running:

```bash
# 1. No hand-rolled parsers remain
test ! -e packages/acp-cli/src/cli-args.ts
test ! -e packages/hrc-cli/src/cli-args.ts
test ! -e packages/hrcchat-cli/src/cli-args.ts

# 2. Every CLI package depends on commander
for p in cli acp-cli hrc-cli hrcchat-cli; do
  jq -e '.dependencies.commander' packages/$p/package.json
done

# 3. Builds, typechecks, tests pass
bun run build
bun run typecheck
bun run test

# 4. Smoke tests still pass for each CLI
bun run --filter 'acp-cli' test -- smoke
bun run --filter 'hrc-cli' test -- smoke
bun run --filter 'hrcchat-cli' test -- smoke

# 5. Help output is auto-generated by commander (no renderXxxHelp helpers)
! rg -q "function renderXxxHelp\|renderTaskHelp\|renderAgentHelp" packages/
```

User‑facing acceptance: `<bin> --help`, `<bin> <verb> --help`, and `<bin> <verb> <subverb> --help` all produce sensible output for `asp`, `acp`, `hrc`, `hrcchat`.

**Status (post Phase 6, 2026-04-27):** asp / acp / hrc / hrcchat satisfy this fully. hrc top‑level verbs and subcommand groups are commander-native and return `Usage:` help with exit 0; the legacy passthrough helper has been removed.

## 10. Open questions

1. **`packages/cli-kit` vs. extending `acp-core`?** Recommend new package. `hrc-cli` should not depend transitively on `acp-core` because `hrc` runs in environments where `acp-core`'s server deps (`acp-server`, `gateway-discord`) are unwanted.
2. **Wrapper convention over commander?** Recommend deferring. Migrate raw, observe the actual repetition, then introduce `defineCommand({ name, options, action })` only if the boilerplate is real.
3. **Should we keep `printJson` / `fatal` shims in each CLI for stylistic consistency?** Recommend no — single source of truth in `cli-kit`.
4. **Per‑CLI binary name in error envelope?** `cli-kit.exitWithError({ binName: 'hrc' })` lets each CLI keep its `hrc:` / `acp:` / `hrcchat:` prefix on stderr without each one re‑implementing the helper.
5. **commander 14's `program.exitOverride()` interaction with bun?** Verify in Phase 1 that thrown exit codes propagate correctly under `bun run` — this is the only Bun‑specific concern.

## 11. References

- Commander v14: https://github.com/tj/commander.js
- npm trends (commander vs alternatives): https://npmtrends.com/clipanion-vs-commander-vs-nopt-vs-optimist-vs-yargs
- Existing in‑repo commander usage: `packages/cli/src/index.ts`
