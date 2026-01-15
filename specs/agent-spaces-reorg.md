** agent-spaces has been refactored as below.  update control-plane to use the new public interface **


I pulled the actual `agent-spaces-v2` workspace and the package graph is “clean layered,” not random: `core → git → resolver → store → materializer → lint`, plus `claude` (CLI/harness integration) and `engine` as the orchestrator that depends on basically everything, and `cli` as the only non‑private publishable surface. That’s a reasonable *architecture*, but it’s a lot of *workspace packaging overhead* for what are currently internal-only building blocks (manual build ordering, bundling/copying dist into `node_modules/spaces-*` in `cli/prepack`, etc.).

So yes: **it’s sensible to consolidate some packages before doing the larger “config-plane vs execution-plane” separation**—and the best consolidation is one that *directly maps* to that future split.

## Recommendation: consolidate to 3 workspaces aligned with the future split

Keep the repo monorepo, but reduce internal packages to:

1) **`spaces-config`** (private): everything needed to produce a deterministic “bundle input”  
   Merge: `core`, `git`, `resolver`, `store`, `materializer`, `lint` (and the “install/build/explain” parts currently in `engine`).

2) **`spaces-exec`** (private): everything that runs an agent/harness + emits artifacts/events  
   Merge: the “run/harness/pi/pi-sdk runner” parts of `engine` + `claude` (and any future harness adapters).

3) **`@lherron/agent-spaces`** (published CLI + facade): depends on both and exposes stable subpath exports.

This gets you out of the “9 packages for one product” feeling, while making the later repo split almost mechanical: `spaces-config` can become “agent-config”, `spaces-exec` can become “execution-plane”.

### Why this is the right consolidation (vs random merges)
The real seam isn’t “store vs materializer” or “git vs resolver”; those are implementation details. The real seam is:
- **config-time determinism** (resolution, locks, envHash, bundle manifests, plugin directories)
- **run-time volatility** (sessions, permission brokerage, event streaming, cancellation, runtime deps)

This seam is exactly what you’ll want when `rex` becomes a pure orchestrator and `agent-spaces` becomes the runtime engine.

## What to combine and what to keep as modules inside the new packages

### `spaces-config` contents
Move these packages in (as internal folders/modules; not workspaces):
- `core/` (types, schemas, errors, lock/atomic write)
- `git/` (registry + tag operations)
- `resolver/` (refs → commits → closure → lock)
- `store/` (CAS snapshots)
- `materializer/` (plugin dir generation + bundle manifests)
- `lint/` (rules)

Also move the “config orchestration” from `engine` into `spaces-config`:
- `resolve*`, `install`, `installNeeded`, `build`, `buildAll`, `explain`, `materializeFromRefs`, etc.

End state: `spaces-config` exposes two stable APIs:
- **primitive**: parse/resolve/store/materialize
- **orchestrator**: install/build/explain workflows

### `spaces-exec` contents
Move in:
- harness registry + adapters (currently `engine/src/harness/*`)
- `pi-sdk/runner.ts` (and any future runners)
- `claude` invocation/detection/validation (current `spaces-claude`)

`spaces-exec` should depend on `spaces-config` *only* through:
- `ComposedTargetBundle` (or whatever you standardize as the “bundle” contract)
- a small set of config snapshot structs (`envHash`, load order, pluginDirs, lock refs)

This keeps the dependency direction clean.

### `@lherron/agent-spaces` (CLI) stays
It becomes thin:
- CLI commands call `spaces-config` for install/build/lint/explain
- CLI run commands call `spaces-exec` (which may call config as needed, but ideally exec consumes an already-built bundle)

Also: keep the existing CLI subpath exports for compatibility, but implement them as re-exports:
- `@lherron/agent-spaces/core` → re-export from `spaces-config/core`
- `.../engine` → either (a) re-export both config+exec orchestrators, or (b) keep an `engine` facade module inside the CLI package that delegates.

## Practical benefits you’ll feel immediately

- You drop from **8 internal workspace packages → 2**, which cuts build choreography and “where does this code live?” overhead.
- You can make `spaces-exec` the place where the **new “runWithArtifacts”** API lives (events JSONL, meta.json, stdout/stderr capture, cancellation), without dragging those runtime deps into all config consumers.
- When you later split into two repos/services, you’re not inventing a seam—you’re formalizing one you already use.

## Concrete migration plan (low-risk, no big-bang)

1) **Create `packages/config` and `packages/exec`** with package.json + tsconfig and empty `src/`.
2) **Move code physically** but keep the old packages temporarily as *compat shims*:
   - Replace each old package’s `src/index.ts` with `export * from 'spaces-config/...'` (or `'spaces-exec/...'`).
   - This lets you update imports incrementally and keeps tests passing.
3) **Split `engine` by responsibility**:
   - Move `resolve/install/build/explain/materialize-refs` → config
   - Move `run + harness + pi/pi-sdk runner` → exec
4) **Update CLI** to import from config/exec directly.
5) **Delete the old packages** once imports stabilize and the shims are no longer needed.

## If you don’t want to consolidate yet: the “minimum fix” to reduce pain
If you keep the current package layout, I’d still fix the main source of “overkill feeling”:

- Replace `build:ordered` with **TypeScript project references** + `tsc -b` so build order is automatic.
- Remove the `cli/prepack` dist-copy hack by switching to a single published package model or a bundler step.

But given your direction (rex delegating runtime to agent-spaces), you’ll benefit more from the config/exec consolidation now.

## Bottom line
Combine now, but combine **along the future seam**: `spaces-config` and `spaces-exec`, with `@lherron/agent-spaces` as the CLI/facade. That reduces current packaging overhead and makes the later separation (agent-config vs execution-plane) straightforward rather than disruptive.  [oai_citation:0‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)
