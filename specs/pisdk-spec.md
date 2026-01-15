**Note: pi documentation is in <project-root>/pi-docs and pi source is in ~/tools/pi-mono if needed during implementation**

Agent-spaces today has a harness registry with two adapters: `claude` and `pi` (`packages/engine/src/harness/{claude-adapter.ts,pi-adapter.ts}`) and core typing/schema that only recognizes `claude|pi` (`packages/core/src/types/harness.ts`, `packages/core/src/schemas/space.schema.json`). The engine `run()` path is currently hard-coded: anything that isn’t `claude` is treated as “pi” via `buildPiBundle()` and then spawned as an external command (`packages/engine/src/run.ts`).

Your current `pi` harness implementation is built around a CLI-style runner and a Pi-specific bundle layout (`extensions/`, `skills/`, etc). However, `pi-mono` (the pi-sdk project you provided) is the `@mariozechner/pi-coding-agent` monorepo, and its SDK surface looks materially different from what `pi-adapter.ts` assumes:

- pi-sdk’s **extensions** are “extension factories”: `type ExtensionFactory = (pi: ExtensionAPI) => void|Promise<void>`, registered via `pi.on('tool_call' | 'tool_result' | ...)`, and can **block tool calls** by returning `{ block: true }` from a `tool_call` handler.
- pi-sdk’s **project context** expects “context files” (internally discovered from `AGENTS.md` / `CLAUDE.md`), but SDK `createAgentSession()` supports passing `contextFiles` directly (so we don’t have to write into the user repo).
- pi-sdk’s **skills** are directories containing `SKILL.md`, and the SDK can take `skills` directly (so you can avoid global/project skill discovery if you want).
- pi-sdk’s CLI flags and event names don’t match the current `pi-adapter.ts` assumptions (so this really wants to be a **new harness**, not a tweak of the existing `pi` harness).

Net: adding `pi-sdk` cleanly will be easiest if we treat it as a distinct harness with its own adapter and a small runner process that uses the SDK.

---

## Proposed design: `pi-sdk` harness as an SDK-backed runner + bundle manifest

### 1) Harness identity
Add a new harness id: **`pi-sdk`** (kebab-case, consistent with agent-spaces ids).

Keep the existing `pi` harness intact.

### 2) Bundle output contract (what `asp install` produces)
Under `asp_modules/<target>/pi-sdk/`, produce a **self-contained bundle** with a **manifest file** that the runner can use without re-reading original space snapshots.

Recommended layout:

```
asp_modules/<target>/pi-sdk/
  bundle.json                # runner contract (authoritative)
  extensions/                # bundled JS extension entrypoints (namespaced)
  skills/                    # merged skills (directories with SKILL.md)
  hooks/                     # merged hook scripts (namespaced or last-wins)
  context/                   # per-space instruction/context markdown files
  shared/                    # optional: merged shared assets if you need them
```

The key is `bundle.json`; it should explicitly list extension entrypoints in the correct load order, and list hook definitions with resolved script paths relative to the bundle root.

### 3) Runner contract (what `asp run` spawns)
`asp run --harness pi-sdk` should spawn a runner script (shipped inside agent-spaces) that:

- Reads `bundle.json`
- Loads extension factories (dynamic import of compiled `.js` entrypoints)
- Creates an SDK session via `createAgentSession({ extensions, skills, contextFiles, cwd, ... })`
- Runs either:
  - `InteractiveMode(session, { initialMessage })` for interactive
  - `runPrintMode({ session, initialMessage })` for prompt mode

This keeps agent-spaces’ engine/CLI architecture (spawn external “harness command”) unchanged, while letting the runner do SDK-native behavior.

### 4) Hooks and (optional) permissions become first-class (SDK advantage)
Because pi-sdk extensions can handle `tool_call` and return `{block: true}`, `pi-sdk` harness can support **blocking hooks** (and eventually permissions enforcement) in a way the CLI harness can’t.

I’d implement hooks (and optionally permission checks) as one additional **built-in extension factory** injected by the runner (not a generated file), driven by the canonical hooks read/merged during `composeTarget`.

---

## Implementation plan (concrete steps)

### Step A — Core + schema wiring (agent-spaces “platform” work)
1) **Add `pi-sdk` to harness ids**
   - `packages/core/src/types/harness.ts`
     - Extend `HARNESS_IDS` and `HarnessId` union to include `'pi-sdk'`.
     - Extend `ComposedTargetBundle` union to include a `PiSdkTargetBundle` shape (details below).

2) **Update space schema**
   - `packages/core/src/schemas/space.schema.json`
     - Allow `harness.supports` entries to include `"pi-sdk"`.

3) **Update any harness id validators**
   - Wherever `isHarnessId()` / `HARNESS_IDS` is used (CLI parsing, etc).

Deliverable: the CLI accepts `--harness pi-sdk`, schemas validate it, and types compile.

---

### Step B — Add a new adapter: `PiSdkAdapter`
Create `packages/engine/src/harness/pi-sdk-adapter.ts` implementing `HarnessAdapter<'pi-sdk'>`.

#### B1) `detect()`
Goal: tell engine how to spawn it and whether it’s available.

- Return `path: 'bun'` (or `path: 'node'`) and `capabilities: ['sdk', 'tui', ...]`.
- Detect pi-sdk availability in one of two ways (support both):
  1) Preferred: pi-sdk is installed as a dependency of agent-spaces (`@mariozechner/pi-coding-agent`).
     - detection: attempt a dynamic import; if it fails, mark unavailable with a good message.
  2) Dev mode: allow env var `ASP_PI_SDK_ROOT` pointing at a local `pi-mono` checkout + built dist.
     - detection: check for expected dist entrypoint path(s).

In either case, the adapter should also compute the runner script path (relative to the engine package dist output) so buildRunArgs can include it.

#### B2) `validateSpace()`
Minimal initial validation:
- If a space declares `harness.supports`, skip if it doesn’t include `pi-sdk`.
- Validate that `extensions/` (if present) contains supported entrypoints (see B3).
- Validate that `skills/` entries look like `*/SKILL.md` (optional; warning-only).

#### B3) `materializeSpace()`
Inputs: `{ manifest, snapshotPath, cacheDir, ... }`

This should produce a cache artifact that is easy to merge later.

Minimum required artifacts:
- `cacheDir/extensions/` — compiled/bundled JS entrypoints for pi-sdk runner to import
- `cacheDir/skills/` — copied skill directories
- `cacheDir/hooks/` — copied hook scripts + hooks.toml (or just scripts; see compose)
- `cacheDir/context/` — the space’s instruction file (`AGENT.md`) copied as a context file

Extension handling recommendation:
- Keep your existing “bundle each extension entrypoint” approach, but make it **runtime-correct** for pi-sdk runner:
  - If runner uses `node`, bundle for node ESM.
  - If runner uses `bun`, bundling can stay bun-targeted.
- Namespacing: output compiled extension files as:
  - `extensions/<spaceId>__<relativePathNormalized>.mjs` (or `.js`)
- Discovery of entrypoints:
  - Start with the current behavior (“root-level `.ts/.js` files”), but if you want parity with pi-sdk’s own extension discovery, extend it to:
    - include `extensions/*/index.{ts,js}`
    - allow explicit list via `space.toml` (e.g., `pi.extensions = [...]`) if you already have that schema field

#### B4) `composeTarget()`
Inputs: `{ targetName, outputDir, artifacts[] in load order }`

Work to do:
1) Create output dirs: `extensions/`, `skills/`, `hooks/`, `context/`.
2) Merge:
   - Extensions: copy all compiled entrypoints into `outputDir/extensions/` (collision-free because namespaced).
   - Skills: merge directories like current pi adapter does; keep “later wins” and emit warnings on collisions.
   - Hooks: merge scripts into `outputDir/hooks/` (either namespaced by spaceId or last-wins; I strongly recommend namespacing to avoid accidental overrides).
   - Context: copy each space’s `AGENT.md` into `outputDir/context/<spaceId>.md` (or similar).
3) **Write `bundle.json`**
   - This is the crucial piece for `asp run`.

Recommended `bundle.json` shape (versioned):

```json
{
  "schemaVersion": 1,
  "harnessId": "pi-sdk",
  "targetName": "<target>",
  "rootDir": "<abs path>",
  "extensions": [
    { "spaceId": "a", "path": "extensions/a__foo.mjs" },
    { "spaceId": "b", "path": "extensions/b__bar.mjs" }
  ],
  "skillsDir": "skills",
  "contextFiles": [
    { "spaceId": "a", "path": "context/a.md", "label": "space:a instructions" }
  ],
  "hooks": [
    {
      "event": "pre_tool_use",
      "tools": ["Bash", "Write"],
      "script": "hooks/a/pre_tool_use.sh",
      "blocking": true
    }
  ]
}
```

Notes:
- `extensions[]` order should follow the **target load order** and then a stable per-space ordering (manifest order or alphabetical). Don’t rely on filesystem glob order at runtime.
- `hooks[]` should already be canonical, filtered for `pi-sdk`, and script paths should be relative to bundle root.

4) Return a `PiSdkTargetBundle` (and include `bundleManifestPath` so `buildRunArgs` doesn’t need to rediscover).

#### B5) `buildRunArgs()`
For `pi-sdk`, this should construct args to run the runner script with the right flags, e.g.:

- `bun <runnerPath> --bundle <bundleRoot> --project <projectPath> --cwd <cwd> --mode interactive|print --prompt ... --model ...`

This is where you decide how much of `asp run`’s options are translated vs passed through:
- `--interactive` / `--prompt` are first-class.
- `--model`: either implement a mapping (see below) or treat it as a pi-sdk model id string.
- `--yolo`: pass to runner (to disable blocking hooks/permissions checks).
- `--extraArgs`: pass through to runner for pi-sdk-specific toggles.

---

### Step C — Refactor `engine/run.ts` so “non-claude != pi”
Right now `run()` has a hard-coded `buildPiBundle()` for any non-claude harness.

To add `pi-sdk`, you need a general mechanism to load a bundle from disk.

Best minimal refactor:
1) In each harness output directory, require a standard `bundle.json` file.
2) Add a small helper in engine, e.g. `loadBundleFromHarnessOutput(harnessId, harnessOutputPath)`:
   - for `pi` (existing), you can either:
     - keep old logic temporarily, OR
     - update `pi` composeTarget to also write `bundle.json` so run can be unified
   - for `pi-sdk`, read `bundle.json`
3) Update `run()`:
   - load bundle metadata via helper
   - call `adapter.buildRunArgs(bundle, { ... })`
   - spawn using `detection.path`

This is the single biggest “make future harnesses easy” change.

---

### Step D — Implement the `pi-sdk` runner script
Create something like:

- `packages/engine/src/harness/pi-sdk/runner.ts` (compiled into the engine dist)
- It should be callable as a standalone script.

Responsibilities:

1) **Parse args**
   - `--bundle <path>` (required)
   - `--project <path>` (required; used for resolving default `cwd` and/or for display)
   - `--cwd <path>` (optional; default = project)
   - `--mode interactive|print` (required)
   - `--prompt <string>` (optional)
   - `--model <string>` (optional)
   - `--yolo` (optional)
   - pass-through flags as needed

2) **Read `bundle.json`**
   - Compute `bundleRoot` absolute path.

3) **Load extension factories**
   - For each entry in `bundle.extensions`, dynamic-import the file and read its default export.
   - Validate it’s a function; if not, print a clear error including file path and exit non-zero.

4) **Build the “asp bridge” extension (inline)**
   - This extension handles hooks (and optionally permissions).
   - It registers handlers like:
     - `pi.on('tool_call', async (e) => { ... })`
     - `pi.on('tool_result', async (e) => { ... })`
     - `pi.on('session_start', ...)`
     - `pi.on('session_shutdown', ...)`
   - Hook execution:
     - Filter hook list by event and tool name (normalize tool names).
     - Execute scripts with a stable environment contract (see below).
     - If `hook.blocking` and exit code != 0, return `{ block: true, reason: ... }`.
   - Put this extension first in the list if you want it to enforce before other extensions.

5) **Load skills**
   - Read from `<bundleRoot>/<skillsDir>` and produce `Skill[]`.
   - Prefer calling pi-sdk’s skill loader if exposed publicly; otherwise implement:
     - list directories under skillsDir
     - parse `SKILL.md` content
   - Pass `skills` explicitly to `createAgentSession()` so you don’t pick up user/global skills unless you intend to.

6) **Load context files**
   - Read `bundle.contextFiles[]` contents and pass to `createAgentSession({ contextFiles })`.
   - This avoids writing `AGENTS.md` into the user repo.

7) **Create the session**
   - `createAgentSession({ cwd, extensions, skills, contextFiles, model, ... })`
   - Model mapping: see below.

8) **Run mode**
   - interactive:
     - `new InteractiveMode(session, { initialMessage: prompt? })`
     - `await mode.run()`
   - print:
     - `await runPrintMode({ session, initialMessage: prompt })`

9) **Exit codes**
   - Non-blocking hook failures should not crash the runner (log and continue).
   - Blocking hook failures should block the tool call (but keep the session running).
   - Fatal errors (bundle missing, extension load fail) should exit non-zero.

#### Hook script environment contract
Define a stable set of env vars so scripts are portable across harnesses:

- `ASP_HARNESS=pi-sdk`
- `ASP_TARGET=<target>`
- `ASP_BUNDLE_ROOT=<abs path>`
- `ASP_EVENT=<canonicalEvent>` (e.g. `pre_tool_use`)
- `ASP_TOOL_NAME=<tool>` (for tool events)
- `ASP_TOOL_INPUT=<json>` (stringified)
- `ASP_TOOL_RESULT=<json>` (for post tool)
- `ASP_SESSION_ID=<id>` (if available)
- `ASP_SPACE_IDS=<comma-separated>` (optional)

If you want parity with existing `pi-adapter.ts`’s intent, keep `ASP_HOOK_EVENT/ASP_HOOK_TYPE` naming too, but I’d normalize on one scheme.

---

### Step E — Decide model flag semantics (`asp run --model`)
This is a common footgun because agent-spaces today treats model as “Claude model name”, but pi-sdk supports multiple providers.

Options (pick one, document it):
1) **Provider-qualified model**: require `--model <provider>:<modelId>` for pi-sdk.
   - Example: `--model anthropic:claude-3-5-sonnet-20240620`
2) **Back-compat shortcuts**: allow `sonnet|haiku|opus` and map to Anthropic defaults.
3) **Pass-through**: ignore `--model` for pi-sdk and require user to use `--extraArgs` to set provider/model for now.

I’d implement (1) + (2) quickly: accept `provider:model` explicitly; accept the shortcuts as convenience.

---

### Step F — CLI UX changes
1) Update `packages/cli/src/commands/run.ts`
   - `--harness` help text: include `pi-sdk`
   - (Optional) improve `--model` help: mention provider:model for pi-sdk

2) Update `packages/cli/src/commands/install.ts`
   - Today it prints a direct command for pi/claude; for `pi-sdk` you can:
     - either print the `asp run --harness pi-sdk --target ...` invocation (most straightforward)
     - or print the underlying `bun <runner> ...` for debugging (useful for maintainers)

3) Update `packages/cli/src/commands/harnesses.ts` to list pi-sdk.

---

## Testing plan

### Unit tests (fast, no LLM)
- Adapter composition:
  - Given 2 fake artifacts with extensions/skills/hooks, `composeTarget()` produces:
    - expected directory structure
    - deterministic `bundle.json` ordering
- Runner “bundle load”:
  - Create a temp bundle with a trivial extension module exporting default `(pi)=>{}` and verify runner can import it.
- Hook blocking behavior:
  - Create a dummy script that exits 1; ensure tool_call handler returns `{block:true}` and pi-sdk session blocks tool call (you can unit test the hook extension factory’s behavior without running the full agent).

### Integration tests (optional, behind env guard)
- If you have a mock model provider (or can run with a deterministic stub model), run:
  - `asp install --harness pi-sdk ...`
  - `asp run --harness pi-sdk --prompt "..."` and assert the runner starts and executes one turn.

### Manual smoke tests
- A sample space with:
  - one extension registering a trivial tool and logging `tool_call/tool_result`
  - one skill
  - one blocking pre_tool_use hook that denies `bash`
- Verify:
  - interactive mode starts
  - tool calls trigger hooks and can be blocked
  - skills show up in the system prompt / behavior

---

## Key risks / caveats to plan for

1) **Runtime choice (bun vs node)**  
pi-sdk is Node-oriented but has bun accommodations in the source. Still, if any dependency is Node-native, bun may be problematic. If you want lowest risk: run the pi-sdk runner under **node** and bundle extensions for node ESM. If you want “single-runtime” simplicity: use bun, but test early.

2) **Extension dependency resolution**  
If space extensions import third-party npm packages that aren’t installed in agent-spaces’ environment, dynamic import will fail. Bundling can help only if those deps are resolvable at bundle time. You should document an explicit constraint (e.g., “extensions must be dependency-free or depend only on packages available in the harness runtime”).

3) **Instruction/context mismatch**  
agent-spaces uses `AGENT.md`; pi-sdk discovers `AGENTS.md/CLAUDE.md`. Passing `contextFiles` directly avoids writing into user repos and avoids filename mismatch entirely.

4) **Hook semantics definition**  
You’ll need to define what constitutes “block”: exit code non-zero vs special stdout JSON. Keep it simple first (exit code), then add richer protocol later if needed.

---

## Minimal “phase 1” vs “phase 2” split

If you want a thin first implementation that still provides value:

**Phase 1**
- Add harness id + adapter
- Install produces `bundle.json`, extensions, skills, context
- Runner loads extensions + skills + context and runs interactive/print

**Phase 2**
- Add hook bridge extension (blocking + non-blocking)
- Add permission enforcement (block tool calls based on canonical permissions), wired to `--yolo`

That gives you a working pi-sdk harness quickly, then you layer the SDK-native advantages.

---

If you want, I can also outline an exact file-by-file diff plan (what new files get added, what functions change) based on your preferred runtime choice (node vs bun) and how strict you want isolation (inherit user/project pi settings vs fully isolated).
