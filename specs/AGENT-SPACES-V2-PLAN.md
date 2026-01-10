# Agent Spaces v2 Implementation Plan

## Overview

Greenfield implementation of Agent Spaces v2 - a CLI tool for composing Claude Code plugin environments from versioned, reusable Spaces stored in a git-backed registry.

**Tech Stack**: TypeScript, Bun, Commander.js, shell-out to git

**Key Principle**: Users recreate spaces from scratch (no v1 migration).

**Runtime Model (explicit)**:
- Each Space materializes to a standalone Claude Code plugin directory (one `.claude-plugin/plugin.json` per Space).
- A Run Target composes multiple Spaces by loading multiple plugin directories in a deterministic `loadOrder`.
- `asp run` launches Claude via repeated `--plugin-dir <path>` flags, in `loadOrder`.

**Day-to-day ergonomics**:
- `asp build` materializes plugins to an output directory without launching Claude.
- `asp explain` prints the resolved graph/pins/load order + warnings (human + JSON).
- `asp add/remove/upgrade/diff` provide package-manager-grade UX for targets composition.

---

## Project Structure

```
agent-spaces-v2/
├── package.json              # Workspace root
├── biome.json                # Linting/formatting
├── tsconfig.json             # Base TS config
├── packages/
│   ├── cli/                  # CLI entry point (asp command) - THIN layer
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts      # Entry point
│   │   │   └── commands/     # Command implementations (delegate to engine)
│   │   │       ├── run.ts
│   │   │       ├── build.ts
│   │   │       ├── explain.ts
│   │   │       ├── install.ts
│   │   │       ├── add.ts
│   │   │       ├── remove.ts
│   │   │       ├── upgrade.ts
│   │   │       ├── diff.ts
│   │   │       ├── lint.ts
│   │   │       ├── list.ts
│   │   │       ├── doctor.ts
│   │   │       ├── gc.ts
│   │   │       └── repo/
│   │   │           ├── init.ts
│   │   │           ├── status.ts
│   │   │           ├── publish.ts
│   │   │           └── tags.ts
│   │   └── tests/
│   │
│   ├── engine/               # Orchestration (resolve → store → materialize → run/build/explain)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── resolve.ts         # High-level resolution entrypoints
│   │   │   ├── install.ts         # Lock/store orchestration
│   │   │   ├── build.ts           # Materialization orchestration
│   │   │   ├── run.ts             # Claude launch orchestration
│   │   │   └── explain.ts         # Debug/explain output (human + JSON)
│   │   └── tests/
│   │
│   ├── claude/               # Claude CLI wrapper (exec + feature detection)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── detect.ts          # Find claude binary, version, supported flags
│   │   │   ├── invoke.ts          # Spawn claude safely (argv array, no shell)
│   │   │   └── validate.ts        # Optional plugin validation (if supported)
│   │   └── tests/
│   │
│   ├── core/                 # Core library (config, schemas, types, locks)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config/       # Config loading & validation
│   │   │   │   ├── space-toml.ts
│   │   │   │   ├── targets-toml.ts
│   │   │   │   └── lock-json.ts
│   │   │   ├── schemas/      # JSON schemas (exported)
│   │   │   │   ├── space.schema.json
│   │   │   │   ├── targets.schema.json
│   │   │   │   └── lock.schema.json
│   │   │   ├── types/        # TypeScript types
│   │   │   │   ├── space.ts
│   │   │   │   ├── targets.ts
│   │   │   │   ├── lock.ts
│   │   │   │   └── refs.ts
│   │   │   ├── errors.ts     # Typed error classes
│   │   │   ├── locks.ts      # Cross-platform file locks for project/store operations
│   │   │   └── atomic.ts     # Atomic file write utilities (write to .tmp, rename)
│   │   └── tests/
│   │
│   ├── resolver/             # Resolution engine (deterministic, minimal)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── ref-parser.ts       # Parse space:<id>@<selector>
│   │   │   ├── selector.ts         # Dist-tag (from metadata), semver, git pin
│   │   │   ├── dist-tags.ts        # Read registry/dist-tags.json for channel resolution
│   │   │   ├── git-tags.ts         # Query git tags for semver resolution
│   │   │   ├── closure.ts          # Dependency closure (DFS postorder)
│   │   │   ├── lock-generator.ts   # Generate asp-lock.json
│   │   │   └── validator.ts        # Cycle detection + structural validation (ERRORS only)
│   │   └── tests/
│   │
│   ├── store/                # Content-addressed store
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── snapshot.ts         # Extract space at commit to store
│   │   │   ├── integrity.ts        # Deterministic integrity (prefer git-tree-based hashing)
│   │   │   ├── git-tree.ts         # List tree entries (path, mode, blob oid) for fast hashing
│   │   │   ├── env-hash.ts         # Environment hash computation
│   │   │   └── paths.ts            # ASP_HOME path helpers
│   │   └── tests/
│   │
│   ├── materializer/         # Plugin directory generation
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── plugin-json.ts      # Generate .claude-plugin/plugin.json
│   │   │   ├── link-components.ts  # Hardlink components from store (fast + disk-efficient)
│   │   │   ├── copy-components.ts  # Fallback copier (when hardlink fails)
│   │   │   ├── hooks-builder.ts    # Validate hooks.json, ensure scripts exist/executable
│   │   │   ├── mcp-composer.ts     # Compose MCP config from spaces (passthrough only)
│   │   │   └── cache.ts            # Cache lookup by pluginCacheKey
│   │   └── tests/
│   │
│   ├── git/                  # Git operations (shell-out wrapper, safe subprocess)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── exec.ts             # Safe exec helper (argv array, no shell interpolation)
│   │   │   ├── tags.ts             # List/create tags (immutable semver tags only)
│   │   │   ├── show.ts             # Read file at commit
│   │   │   ├── archive.ts          # Extract tree at commit
│   │   │   ├── tree.ts             # List tree entries for integrity hashing
│   │   │   └── repo.ts             # Clone, fetch, init, status, remote operations
│   │   └── tests/
│   │
│   └── lint/                 # Linting & warnings (SINGLE source of truth for all warnings)
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── rules/
│       │   │   ├── W201-command-collision.ts
│       │   │   ├── W203-hook-path-no-plugin-root.ts
│       │   │   ├── W204-invalid-hooks-config.ts
│       │   │   ├── W205-plugin-name-collision.ts
│       │   │   └── W206-non-executable-hook-script.ts
│       │   └── reporter.ts
│       └── tests/
│
├── spaces/                   # Shipped spaces (in-repo for now)
│   └── agent-spaces-manager/ # Manager space - actually useful, not just docs
│       ├── space.toml
│       ├── commands/
│       │   ├── help.md
│       │   ├── create-space.md
│       │   ├── add-skill.md
│       │   ├── add-command.md
│       │   ├── add-hook.md
│       │   ├── bump-version.md
│       │   ├── publish.md
│       │   └── update-project-targets.md
│       ├── skills/
│       │   └── space-authoring/
│       │       └── SKILL.md
│       └── agents/
│           └── manager.md        # Coordinator agent for repo + project workflows
│
└── integration-tests/        # End-to-end integration tests
    ├── fixtures/
    │   ├── sample-registry/  # Mock git registry with spaces + dist-tags.json
    │   ├── sample-project/   # Mock project with asp-targets.toml
    │   └── claude-shim/      # Test shim for Claude (records argv, validates plugins)
    └── tests/
        ├── run.test.ts           # Test asp run with claude shim (default)
        ├── run-real-claude.test.ts  # Optional: real Claude e2e (RUN_REAL_CLAUDE=1)
        ├── install.test.ts
        ├── repo-init.test.ts
        └── lint.test.ts
```

---

## Registry Metadata Structure

Dist-tags are **committed metadata**, not moving git tags. This makes promotions PR-reviewable and avoids force-pushing tags.

```
$ASP_HOME/repo/
├── .git/
├── registry/
│   └── dist-tags.json        # { "<spaceId>": { "stable": "v1.2.3", "latest": "v1.3.0" } }
└── spaces/
    ├── my-space/
    │   ├── space.toml
    │   └── ...
    └── other-space/
        └── ...
```

Git tags remain **immutable semver tags**: `space/<id>/v1.0.0`, `space/<id>/v1.1.0`, etc.

---

## Implementation Phases

### Phase 1: Foundation (packages/core, packages/git, packages/claude)

**Goal**: Core types, config parsing, git operations, Claude wrapper, orchestration entrypoints

1. **packages/core**
   - Define TypeScript types matching JSON schemas
   - Implement TOML parsing for `space.toml` and `asp-targets.toml`
   - Implement JSON parsing for `asp-lock.json`
   - Schema validation using Ajv
   - Typed error classes (ConfigError, ResolutionError, etc.)
   - File locking primitives (project lock, global store lock)
   - Atomic file write utilities (write to `.tmp`, then `rename()`)

2. **packages/git**
   - `exec.ts`: Safe exec helper using argv arrays (no shell interpolation)
   - `tags.ts`: List tags matching pattern, create tags (immutable semver only)
   - `show.ts`: Read file contents at specific commit
   - `archive.ts`: Extract directory tree at commit
   - `tree.ts`: List tree entries (path, mode, blob oid) for fast integrity hashing
   - `repo.ts`: Clone, fetch, init, status, remote operations

3. **packages/claude**
   - `detect.ts`: Find claude binary, query version, detect supported flags
   - `invoke.ts`: Spawn claude safely using argv array (no shell)
   - `validate.ts`: Optional plugin validation (if Claude supports it)
   - Support `ASP_CLAUDE_PATH` env override for testing

4. **packages/engine**
   - Single orchestration pipeline used by CLI (and future UI/TUI)
   - Owns locking, caching policy, and structured tracing
   - Consistent behavior across all commands

**Key files**:
- `/packages/core/src/types/space.ts`
- `/packages/core/src/locks.ts`
- `/packages/core/src/atomic.ts`
- `/packages/git/src/exec.ts`
- `/packages/claude/src/invoke.ts`
- `/packages/engine/src/index.ts`

### Phase 2: Resolution Engine (packages/resolver)

**Goal**: Parse refs, resolve selectors, compute dependency closure (deterministic, minimal)

1. **ref-parser.ts**: Parse `space:<id>@<selector>` into structured ref
2. **dist-tags.ts**: Read committed `registry/dist-tags.json` for channel resolution
3. **selector.ts**:
   - Dist-tag resolution via committed `registry/dist-tags.json`
   - Semver resolution via `space/<id>/v*` tags + semver satisfies
   - Direct `git:<sha>` pin
4. **closure.ts**:
   - Ordered DFS postorder traversal
   - Cycle detection (error on circular)
   - Diamond deps allowed (warn via lint collision rules)
5. **lock-generator.ts**: Generate/update `asp-lock.json`
6. **validator.ts**: Structural validation (cycles, missing deps, invalid refs) → **errors only, no warnings**

**Key algorithm** (dependency closure):
```
visit(space):
  if visited: return
  mark visited
  for dep in space.deps.spaces (declared order):
    resolve dep -> spaceKey
    visit(resolved)
  append(space) to loadOrder

for root in compose (order):
  resolve root -> spaceKey
  visit(resolved)

return loadOrder
```

### Phase 3: Store & Integrity (packages/store)

**Goal**: Content-addressed storage, fast integrity verification

1. **paths.ts**:
   - `ASP_HOME` resolution (default `~/.asp`, override via env)
   - Path builders for store/cache/repo subdirs
2. **git-tree.ts**:
   - List tree entries (path, mode, blob oid) from git
   - Used for fast integrity hashing without file I/O
3. **integrity.ts**:
   - Canonical SHA256 hash per spec (stable format)
   - **Prefer git-tree-based hashing**: hash `path + mode + blobOID` (fast, no file I/O)
   - Fallback to file-walk hashing only for dev-mode filesystem paths
4. **snapshot.ts**:
   - Extract space directory at commit into store
   - Store at `$ASP_HOME/store/spaces/sha256/<hash>/`
5. **env-hash.ts**:
   - Compute `envHash` from loadOrder + integrities

### Phase 4: Materialization (packages/materializer)

**Goal**: Generate Claude Code plugin directories (fast, atomic, disk-efficient)

1. **plugin-json.ts**:
   - Generate `.claude-plugin/plugin.json` from space.toml
   - Required: `name` (kebab-case)
   - Optional: `version`, `description`

2. **link-components.ts**:
   - **Prefer hardlinking** from store snapshot into plugin cache (fast + disk-efficient)
   - Fallback to copy when hardlinking not possible (cross-device/permissions)
   - Preserve executable bits for hook scripts
   - **All materializations are atomic**: write to temp dir then `rename()`

3. **copy-components.ts**:
   - Fallback copier used when hardlink fails
   - Handles cross-device copies

4. **hooks-builder.ts**:
   - If `hooks/` exists, require `hooks/hooks.json`
   - Validate schema + referenced scripts exist in plugin output
   - Enforce `${CLAUDE_PLUGIN_ROOT}` best practice (lint rule)
   - Ensure hook scripts are executable or wrapped with known interpreter
   - Optional: compile `hooks/src/*.ts` → `.asp/compiled/hooks/*.js` and rewrite hook commands

5. **mcp-composer.ts**:
   - Scan spaces for `mcp/mcp.json`
   - Compose into single `.mcp.json` format for `--mcp-config`
   - **Configuration passthrough only** - not building MCPs

6. **cache.ts**:
   - Cache lookup by `pluginCacheKey`
   - Store at `$ASP_HOME/cache/materialized/<key>/<pluginName>/`

### Phase 5: CLI Commands (packages/cli)

**Goal**: CLI is a thin argument parser; core behavior lives in packages/engine

**Priority order**:

1. **`asp run <target|spaceRef|path>`** (most critical)
   - Project mode: resolve target from asp-targets.toml + lock
   - Global mode: resolve space ref, use global-lock.json
   - Dev mode: run from filesystem path
   - Acquire project lock during lockfile read/update + cache materialization
   - Materialize, invoke `claude --plugin-dir ...` in loadOrder
   - If MCP present: also pass `--mcp-config`

2. **`asp build <target|spaceRef|path> --output <dir>`**
   - Materialize plugin directories without launching Claude
   - Useful for debugging, sharing, and CI validation

3. **`asp explain <target|spaceRef|path> [--json]`**
   - Print resolved graph, pins, load order, cache hit/miss, and warnings
   - Human-readable by default, `--json` for tooling

4. **`asp install [--json]`**
   - Parse asp-targets.toml
   - Resolve all targets
   - Acquire project lock while writing asp-lock.json (atomic write)
   - Acquire global store lock while extracting snapshots
   - Generate/update asp-lock.json
   - Populate store with snapshots

5. **`asp add <spaceRef> --target <name>`**
   - Update asp-targets.toml (atomic), then run install

6. **`asp remove <spaceId> --target <name>`**
   - Update asp-targets.toml (atomic), then run install

7. **`asp upgrade [spaceId] [--target <name>]`**
   - Update asp-lock.json pins according to selectors (package-manager-style)

8. **`asp diff [--target <name>] [--json]`**
   - Show pending lock changes without writing (useful in CI and review)

9. **`asp repo init [--clone <url>]`**
   - Create/clone registry at $ASP_HOME/repo
   - Initialize skeleton structure with `registry/dist-tags.json`
   - Install agent-spaces-manager space
   - Final step: `asp run agent-spaces-manager`

10. **`asp repo publish <spaceId> --tag vX.Y.Z [--dist-tag stable]`**
    - Validate space passes lint
    - Create immutable git tag `space/<id>/vX.Y.Z`
    - Optionally update `registry/dist-tags.json` (e.g. stable/latest/beta) and commit

11. **`asp lint [--json]`**
    - Project mode: validate targets + lock coherence
    - Space mode: validate individual space
    - Emit warnings with codes

12. **`asp list [--json]`**
    - List targets, resolved spaces, cached envs

13. **`asp doctor`**
    - Check claude binary exists
    - Check registry remote reachable
    - Check cache permissions

14. **`asp gc`**
    - Prune store + cache based on reachability from locks (project + global)

15. **`asp repo status`**, **`asp repo tags`**
    - Supporting repo management commands

### Phase 6: Linting Rules (packages/lint)

**Goal**: Implement all warning rules (SINGLE source of truth for warnings)

1. **W201 command-name-collision**: Same command in multiple spaces
2. **W203 hook-path-no-plugin-root**: Hook path missing `${CLAUDE_PLUGIN_ROOT}`
3. **W204 invalid-hooks-config**: hooks/ exists but hooks/hooks.json missing/invalid or references missing scripts
4. **W205 plugin-name-collision**: Two spaces produce same plugin name
5. **W206 non-executable-hook-script**: Referenced hook script is not executable and not wrapped

### Phase 7: Manager Space (spaces/agent-spaces-manager)

**Goal**: Actually useful manager space that does real work

```
spaces/agent-spaces-manager/
├── space.toml
├── commands/
│   ├── help.md                    # Show available asp commands
│   ├── create-space.md            # Scaffold new space with correct layout
│   ├── add-skill.md               # Add skill with best-practice template
│   ├── add-command.md             # Add command with template
│   ├── add-hook.md                # Add hook with validation
│   ├── bump-version.md            # Update version in space.toml
│   ├── publish.md                 # Run asp repo publish
│   └── update-project-targets.md  # Help update project asp-targets.toml
├── skills/
│   └── space-authoring/
│       └── SKILL.md               # Guide for creating spaces
└── agents/
    └── manager.md                 # Coordinator agent for repo + project workflows
```

The manager space should:
- Guide users through space creation
- Use fully-qualified `/agent-spaces-manager:command` forms
- Scaffold new spaces with correct layout and initial content
- Add skills/commands/hooks with best-practice templates
- Update versions and run `asp repo publish`
- Help update project `asp-targets.toml` (targets composition surface)

---

## MCP Support Clarification

MCP support is **configuration passthrough only**:

1. Spaces can include `mcp/mcp.json` defining MCP server connections
2. At runtime, asp composes these into a single config file
3. asp passes `--mcp-config <path>` to claude
4. asp does NOT run MCP servers itself - Claude Code handles that

Example `mcp/mcp.json` in a space:
```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@org/my-mcp-server"]
    }
  }
}
```

---

## Testing Strategy

**Integration tests are prioritized** (per user requirement).

### Claude Shim Strategy

Default integration tests use a **claude-shim** executable that:
- Records argv to a file for assertions
- Validates plugin directory structure
- Returns success without launching real Claude

Real Claude tests exist but are **gated behind `RUN_REAL_CLAUDE=1`** and skipped by default.

The `ASP_CLAUDE_PATH` env var allows tests to inject the shim.

### Integration Test Structure

```
integration-tests/
├── fixtures/
│   ├── sample-registry/      # Git repo with test spaces + registry/dist-tags.json
│   │   ├── .git/
│   │   ├── registry/
│   │   │   └── dist-tags.json
│   │   └── spaces/
│   │       ├── base/
│   │       │   └── space.toml
│   │       ├── frontend/
│   │       │   ├── space.toml
│   │       │   └── commands/build.md
│   │       └── backend/
│   │           └── space.toml
│   ├── sample-project/
│   │   └── asp-targets.toml
│   └── claude-shim/
│       └── claude             # Shim executable
└── tests/
    ├── run.test.ts            # Test asp run with claude shim (default)
    ├── run-real-claude.test.ts   # Optional: real Claude e2e (RUN_REAL_CLAUDE=1)
    ├── install.test.ts        # Test resolution + lock generation
    ├── repo-init.test.ts      # Test repo initialization
    └── lint.test.ts           # Test warning detection
```

### Test Scenarios

1. **`asp install` flow**
   - Create fixture registry with tagged spaces + dist-tags.json
   - Create project with asp-targets.toml
   - Run `asp install`
   - Verify asp-lock.json generated correctly
   - Verify store populated

2. **`asp run` flow**
   - Install first
   - Run target
   - Verify invoked with correct `--plugin-dir` flags via shim argv capture
   - Verify materialized plugin structure on disk
   - Optional real-Claude: verify session boots when enabled

3. **`asp build` flow**
   - Build target to output directory
   - Verify plugin directories created without Claude launch

4. **`asp explain` flow**
   - Explain target
   - Verify output shows load order, pins, warnings
   - Test `--json` output format

5. **Collision detection**
   - Two spaces with same command name
   - Verify W201 warning emitted

6. **Dependency closure**
   - Space A depends on B, B depends on C
   - Verify load order: C, B, A

7. **Circular dependency**
   - Space A depends on B, B depends on A
   - Verify resolution error

8. **Hooks validation**
   - Space with invalid hooks config
   - Verify W204 warning emitted

---

## Verification Plan

After implementation, verify end-to-end:

1. **Initialize registry**
   ```bash
   asp repo init
   # Verify ~/.asp/repo created
   # Verify registry/dist-tags.json exists
   # Verify agent-spaces-manager installed
   ```

2. **Create and publish a space**
   ```bash
   # In ~/.asp/repo/spaces/my-space/
   # Create space.toml, commands/, etc.
   asp repo publish my-space --tag v1.0.0 --dist-tag stable
   asp repo tags my-space
   # Verify tag created
   # Verify dist-tags.json updated
   ```

3. **Create project and install**
   ```bash
   # In project dir, create asp-targets.toml
   asp install
   # Verify asp-lock.json created
   asp list
   ```

4. **Add/remove spaces**
   ```bash
   asp add space:my-space@stable --target dev
   asp diff
   asp remove my-space --target dev
   ```

5. **Run target**
   ```bash
   asp run <target>
   # Verify Claude launches with correct plugins
   # Verify /plugin:command works
   ```

6. **Build without Claude**
   ```bash
   asp build <target> --output ./plugins
   # Verify plugin directories created
   ```

7. **Explain resolution**
   ```bash
   asp explain <target>
   # Verify load order, pins, warnings displayed
   asp explain <target> --json
   # Verify JSON output
   ```

8. **Lint project**
   ```bash
   asp lint
   # Verify warnings for collisions if present
   ```

9. **Garbage collection**
   ```bash
   asp gc
   # Verify unreferenced store/cache entries removed
   ```

---

## Dependencies

```json
{
  "dependencies": {
    "commander": "^12.x",
    "@iarna/toml": "^2.x",
    "ajv": "^8.x",
    "semver": "^7.x",
    "chalk": "^5.x",
    "proper-lockfile": "^4.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "bun-types": "latest",
    "@types/semver": "^7.x",
    "@types/proper-lockfile": "^4.x"
  }
}
```

---

## Key Design Decisions

1. **Shell out to git** - Simpler than isomorphic-git, leverages system git
2. **Safe subprocess execution** - Use argv arrays, disable shell interpolation to avoid injection
3. **Monorepo** - Clean separation of concerns, independent testing
4. **CLI is thin, engine does work** - Consistent behavior, testable without commander
5. **Commander.js** - Mature, TypeScript support, subcommands
6. **Ajv for validation** - Standard JSON Schema validation
7. **No v1 migration** - Clean break, users recreate spaces
8. **Dist-tags are committed metadata** - Semver tags are immutable; channel promotion is PR-reviewable
9. **Warnings live in lint package only** - Resolver is deterministic + minimal (errors only)
10. **Git-tree-based integrity hashing** - Fast, no file I/O for registry spaces
11. **Hardlinks + atomic writes** - Fast materialization, robust against interruption
12. **MCP passthrough** - asp composes config, Claude runs servers
13. **Claude shim for tests** - Real Claude tests are opt-in
14. **Structured output** - `--json` flag on key commands for tooling

---

## Next Steps (Implementation Order)

1. Initialize monorepo with Bun workspaces
2. Implement packages/core (types, config, schemas, locks, atomic writes)
3. Implement packages/git (safe shell wrapper, tree listing)
4. Implement packages/claude (detection, safe invocation)
5. Implement packages/resolver (refs, selectors, dist-tags from metadata, closure)
6. Implement packages/store (paths, git-tree integrity, snapshots)
7. Implement packages/materializer (hardlinks, atomic writes, hooks validation)
8. Implement packages/engine (orchestration layer)
9. Implement packages/lint (all warning rules)
10. Implement packages/cli (run, build, explain, install, add/remove/upgrade/diff, repo commands, gc)
11. Create agent-spaces-manager with real functionality
12. Write integration tests with claude-shim
13. End-to-end verification
