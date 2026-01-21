## Committed architecture spec: one harness = one package

### Design rule
After this refactor, **no harness-specific code lives in `spaces-execution`** except “import + register”. All harness-specific logic (detection, bundle IO, run env, arg building, programmatic sessions) lives in **exactly one harness package**.

---

## 1) Package graph and responsibilities

### `spaces-config` (unchanged role)
Owns **types + schemas + deterministic materialization orchestration**, including the canonical `HarnessAdapter` interface and `ComposedTargetBundle` shape.

### `spaces-runtime` (new)
Owns **harness-agnostic runtime primitives** that harness packages must depend on, but that **do not pull in any harness deps**.

It contains:
- `HarnessRegistry` (class, no built-ins)
- `SessionRegistry` + `createSession()` (registry-driven, no hardcoded switches)
- `UnifiedSession` + event types + permission handler types
- Run event emitter utilities (currently `packages/execution/src/events/*`)

### Harness packages (new; one per harness family)
Each harness package contains:
- the harness adapter(s)
- any CLI wrapper / detection code for that harness
- any programmatic session implementation for that harness (if supported)
- a single `register(registries)` entrypoint

Committed packages:
- `spaces-harness-claude` (contains **both** `claude` + `claude-agent-sdk` adapters + Agent SDK session)
- `spaces-harness-pi` (Pi CLI adapter)
- `spaces-harness-pi-sdk` (Pi SDK adapter + `PiSession` + bundle loader)
- `spaces-harness-codex` (Codex adapter + `CodexSession`)

### `spaces-execution` (becomes a facade + orchestrator)
Owns:
- `run.ts` orchestration (install if needed, load bundle, invoke harness generically)
- wrappers around `spaces-config` install/materialize/build functions (current behavior)
- **global singletons** `harnessRegistry` and `sessionRegistry`
- imports each harness package and calls `register(...)`
- re-exports the public surface to keep external imports stable

**Result:** adding a harness becomes “add a new package + one registration line + update config enums”, without touching the runner logic.

---

## 2) Concrete repo layout (final)

```
packages/
  config/
  runtime/                      # NEW (spaces-runtime)
    src/
      harness/registry.ts
      session/types.ts
      session/permissions.ts
      session/registry.ts
      session/factory.ts        # createSession() uses SessionRegistry
      events/events.ts
      events/index.ts
      index.ts

  harness-claude/               # NEW (spaces-harness-claude)
    src/
      claude/*                  # moved from execution/src/claude
      agent-sdk/*               # moved from execution/src/agent-sdk
      adapters/claude-adapter.ts
      adapters/claude-agent-sdk-adapter.ts
      register.ts
      index.ts

  harness-pi/                   # NEW (spaces-harness-pi)
    src/
      adapters/pi-adapter.ts
      register.ts
      index.ts

  harness-pi-sdk/               # NEW (spaces-harness-pi-sdk)
    src/
      adapters/pi-sdk-adapter.ts
      pi-sdk/runner.ts
      pi-session/*              # moved from execution/src/pi-session
      register.ts
      index.ts

  harness-codex/                # NEW (spaces-harness-codex)
    src/
      adapters/codex-adapter.ts
      codex-session/*           # moved from execution/src/codex-session
      register.ts
      index.ts

  execution/                    # existing (spaces-execution)
    src/
      harness/index.ts          # registry singleton + built-in registration + re-exports
      run.ts                    # now fully adapter-driven (no harness branching)
      index.ts                  # wraps config APIs and re-exports runtime + harnesses
```

---

## 3) Mandatory interface changes in `spaces-config`

### 3.1 Extend `HarnessRunOptions` (make run fully adapter-driven)
Add these fields (they’re already in `RunOptions`, but need to be consumable via the adapter contract):

- `permissionMode?: string`
- `settings?: string`
- `debug?: boolean`

(Everything else stays.)

### 3.2 Extend `HarnessAdapter` (removes all harness branching from `run.ts` and CLI)
Add these methods:

```ts
interface HarnessAdapter {
  // existing:
  id: HarnessId
  name: string
  detect(): Promise<HarnessDetection>
  validateSpace(...)
  materializeSpace(...)
  composeTarget(...)
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[]
  getTargetOutputPath(aspModulesDir: string, targetName: string): string

  // NEW (required)
  loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle>

  // NEW (required)
  getRunEnv(bundle: ComposedTargetBundle, options: HarnessRunOptions): Record<string, string>

  // NEW (required)
  getDefaultRunOptions(manifest: ProjectManifest, targetName: string): Partial<HarnessRunOptions>
}
```

**Intent is strict**:
- `loadTargetBundle()` is the *only* place allowed to “understand” the harness’ on-disk bundle layout.
- `getRunEnv()` is the *only* place allowed to define harness env vars (`CODEX_HOME`, `PI_CODING_AGENT_DIR`, `ASP_PLUGIN_ROOT`, etc.).
- `getDefaultRunOptions()` is the *only* place allowed to translate `asp-targets.toml` target defaults into run options.

---

## 4) How `spaces-execution/run.ts` works after refactor (no harness special-cases)

The algorithm is identical for every harness ID, including Claude:

1) Resolve harness + adapter from `harnessRegistry`.
2) Ensure target is installed (existing logic using `harnessOutputExists` + `configInstall` wrapper).
3) `bundle = await adapter.loadTargetBundle(harnessOutputPath, targetName)`
4) `manifest = await loadProjectManifest(projectPath)`
5) `defaults = adapter.getDefaultRunOptions(manifest, targetName)`
6) Build `effectiveRunOptions = mergeDefined(defaults, cliRunOptions)` where **undefined means “not specified”** (so defaults survive), and `null` is treated as a real value (notably `settingSources`).
7) `args = adapter.buildRunArgs(bundle, effectiveRunOptions)`
8) `env = { ...options.env, ...adapter.getRunEnv(bundle, effectiveRunOptions) }`
9) Execute command via a single generic executor (interactive inherits stdio; non-interactive captures and prints).
10) Emit job_started/job_completed events if configured.

**There is no `if (harnessId === ...)` in `run.ts`.**

---

## 5) Harness package obligations (explicit behaviors)

### `spaces-harness-claude`
Implements:
- `loadTargetBundle()`:
  - reads `plugins/` directory and returns ordered `pluginDirs`
  - includes `mcpConfigPath` if `mcp.json` exists and is non-trivial
  - sets `settingsPath` to `settings.json`
- `getDefaultRunOptions()`:
  - uses `getEffectiveClaudeOptions(manifest, targetName)`
  - also reads `target.yolo` and returns `{ yolo: target.yolo ?? false }`
- `buildRunArgs()`:
  - builds standard Claude flags via `buildClaudeArgs`
  - applies `settingSources` normalization internally:
    - `null` => omit flag (inherit all)
    - `undefined` => pass `--setting-sources ""` (isolated default)
    - `"" | "user,project" | ...` => pass through
  - applies prompt handling internally (current behavior):
    - `interactive !== false` => no `-p`
    - `interactive === false` and `prompt` provided => `-p <prompt>`
    - `interactive === false` and no prompt => `-p`
  - if `yolo` => adds `--dangerously-skip-permissions`
- `getRunEnv()`:
  - returns `{ ASP_PLUGIN_ROOT: bundle.rootDir }`

Also registers programmatic session kind:
- `SessionKind: 'agent-sdk'` implemented by `AgentSession` (moved from execution)

### `spaces-harness-pi`
- `loadTargetBundle()` replicates current `buildPiBundle()` semantics (skills dir optional, hook bridge optional).
- `getRunEnv()` returns `{ PI_CODING_AGENT_DIR: bundle.rootDir }`
- `getDefaultRunOptions()` returns `{}`

### `spaces-harness-pi-sdk`
- `loadTargetBundle()` replicates current `loadPiSdkBundle()` semantics (reads `bundle.json`, validates harnessId, detects non-empty dirs).
- `getRunEnv()` returns `{ PI_CODING_AGENT_DIR: bundle.rootDir }`
- `getDefaultRunOptions()` returns `{}`
- registers programmatic session kind:
  - `SessionKind: 'pi'` implemented by `PiSession`

### `spaces-harness-codex`
- `loadTargetBundle()` replicates current `loadCodexBundle()` semantics (validates `codex.home`, `config.toml`, `AGENTS.md`, optionally `mcp.json`).
- `getRunEnv()` returns `{ CODEX_HOME: bundle.codex.homeTemplatePath }`
- `getDefaultRunOptions()` uses `getEffectiveCodexOptions(manifest, targetName)` and also applies target yolo behavior:
  - if yolo => default `{ approvalPolicy: 'never', sandboxMode: 'danger-full-access' }`
- registers programmatic session kind:
  - `SessionKind: 'codex'` implemented by `CodexSession`

---

## 6) Registry + registration (exact contract)

### In `spaces-runtime`
- `export class HarnessRegistry { register(adapter); getOrThrow(id); ... }`
- `export class SessionRegistry { register(kind, factory); getOrThrow(kind); ... }`
- `export function createSession(options: CreateSessionOptions): UnifiedSession`
  - implemented as `sessionRegistry.getOrThrow(options.kind)(options)`

### In each harness package
- `register.ts` exports:

```ts
export function register(reg: {
  harnesses: HarnessRegistry
  sessions: SessionRegistry
}): void
```

This function registers:
- the harness adapter(s) into `reg.harnesses`
- session factories (if any) into `reg.sessions`

### In `spaces-execution/src/harness/index.ts`
- create singletons and register built-ins:

```ts
export const harnessRegistry = new HarnessRegistry()
export const sessionRegistry = new SessionRegistry()

registerClaude({ harnesses: harnessRegistry, sessions: sessionRegistry })
registerPi({ harnesses: harnessRegistry, sessions: sessionRegistry })
registerPiSdk({ harnesses: harnessRegistry, sessions: sessionRegistry })
registerCodex({ harnesses: harnessRegistry, sessions: sessionRegistry })
```

Then `spaces-execution` re-exports `harnessRegistry`, `createSession`, etc.

---

## 7) CLI changes (install/run output becomes adapter-driven)

### `asp install` command generation
Replace the current harness branching with the same adapter-driven pipeline used by `run.ts`:

- detect harness path
- `bundle = await adapter.loadTargetBundle(mat.outputPath, mat.target)`
- `defaults = adapter.getDefaultRunOptions(manifest, mat.target)`
- `args = adapter.buildRunArgs(bundle, defaults)`
- `envPrefix = adapter.getRunEnv(bundle, defaults)`
- render `ENV=... <harnessPath> <args...>` via existing quoting utility

**There is no `if (harnessId === ...)` in CLI install anymore.**

---

## 8) Build + packaging updates (required to make CLI publish work)

### Root build order
Update `build:ordered` to:

1) `spaces-config`
2) `spaces-runtime`
3) each `spaces-harness-*`
4) `spaces-execution`
5) `agent-spaces`
6) CLI

### CLI `prepack` (must copy new internal packages)
Change the loop to copy these into `packages/cli/node_modules/`:
- `spaces-config`
- `spaces-runtime`
- `spaces-harness-claude`
- `spaces-harness-pi`
- `spaces-harness-pi-sdk`
- `spaces-harness-codex`
- `spaces-execution`
- `agent-spaces`

(Your `"files": ["node_modules/spaces-*"]` already matches the naming, so the tarball inclusion stays clean.)

---

## 9) Definition of “done” (non-negotiable acceptance criteria)

1) `spaces-execution/src/run.ts` contains **zero harness-ID branching** (`claude/pi/pi-sdk/codex`).
2) `spaces-execution/src/session/factory.ts` hardcoded branching is deleted; creation is registry-based.
3) Each harness implementation and its deps live **only** in its harness package.
4) Adding a new harness requires edits in exactly three places:
   - `spaces-config`: add `HarnessId` + schema enum
   - new `packages/harness-<new>/` package implementing adapter + `register()`
   - one import + `registerNewHarness(...)` call in `spaces-execution/src/harness/index.ts`
5) CLI install and run continue to work with the existing harnesses without behavior regressions (same args/env as before).

